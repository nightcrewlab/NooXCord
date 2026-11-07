import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ROLE_PERMS, LIMITS, P, has,
  type ChatMethodName, type GuildState, type MethodName, type MethodResults, type Embed,
} from "@nooxcord/shared";
import { Methods } from "@nooxcord/shared/schemas";
import type { Db } from "./db";
import type { Hub } from "./hub";
import type { Media } from "./media";
import type { Store } from "./store";
import { extractUrls, unfurl } from "./unfurl";
import { fail, inviteCode, newId } from "./util";

type Handler = (userId: string, p: never) => unknown;

/** RPC handlers. Every handler validates params with the shared zod schema and checks permissions. */
export class Api {
  private typingAt = new Map<string, number>();

  /** Set by the host once the media service exists; used to drop people from voice. */
  media: Media | null = null;

  constructor(private db: Db, private store: Store, private hub: Hub, private uploadsDir: string) {}

  async call<M extends MethodName>(userId: string, method: M, raw: unknown): Promise<MethodResults[M]> {
    const schema = Methods[method];
    if (!schema) fail("bad_request", "Bilinmeyen işlem.");
    const parsed = schema.safeParse(raw);
    if (!parsed.success) fail("bad_request", parsed.error.issues[0]?.message ?? "Geçersiz istek.");
    const h = (this.handlers as Record<string, Handler>)[method]!;
    return (await h(userId, parsed.data as never)) as MethodResults[M];
  }

  // ---------- helpers ----------
  private need(guildId: string, userId: string, bit: number): number {
    if (!this.store.isMember(guildId, userId)) fail("not_found", "Sunucu bulunamadı.");
    const perms = this.store.perms(guildId, userId);
    if (!has(perms, bit)) fail("forbidden", "Bu işlem için yetkin yok.");
    return perms;
  }

  private channelOf(channelId: string, userId: string, bit: number) {
    const ch = this.store.channel(channelId);
    if (!ch) fail("not_found", "Kanal bulunamadı.");
    this.need(ch!.guildId, userId, bit);
    return ch!;
  }

  /** Text channel or DM. DMs allow viewing, sending and attaching files; only their two members see them. */
  private chatChannel(channelId: string, userId: string, bit: number): { id: string; guildId: string | null; audience: string[]; perms: number } {
    const ref = this.store.chanRef(channelId);
    if (!ref) fail("not_found", "Kanal bulunamadı.");
    if (ref!.guildId === null) {
      const audience = this.store.dmMembers(ref!.id);
      if (!audience.includes(userId)) fail("not_found", "Kanal bulunamadı.");
      const perms = P.VIEW_CHANNELS | P.SEND_MESSAGES | P.ATTACH_FILES;
      if (!has(perms, bit)) fail("forbidden", "Bu işlem için yetkin yok.");
      return { id: ref!.id, guildId: null, audience, perms };
    }
    const perms = this.need(ref!.guildId, userId, bit);
    return { id: ref!.id, guildId: ref!.guildId, audience: this.store.memberUserIds(ref!.guildId), perms };
  }

  /** Highest role position of a member; owner = Infinity. */
  private topPosition(guildId: string, userId: string): number {
    if (this.store.guild(guildId)?.ownerId === userId) return Infinity;
    const r = this.db.get<{ p: number | null }>(
      "SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.guild_id = ? AND mr.user_id = ?",
      guildId, userId,
    );
    return r?.p ?? 0;
  }

  private pushPerms(guildId: string): void {
    for (const uid of this.store.memberUserIds(guildId)) {
      this.hub.toUser(uid, "perms.update", { guildId, myPerms: this.store.perms(guildId, uid) });
    }
    this.media?.refreshPerms(guildId);
  }

  private deleteFiles(stored: string[]): void {
    for (const s of stored) fs.rm(path.join(this.uploadsDir, s), { force: true }, () => {});
  }

  private sendGuildAdd(guildId: string, userId: string): GuildState {
    const state = this.store.guildState(guildId, userId);
    this.hub.toUser(userId, "guild.add", { state, users: this.store.usersInGuilds([guildId]) });
    return state;
  }

  private async attachEmbeds(messageId: string, content: string): Promise<void> {
    const urls = extractUrls(content);
    if (urls.length === 0) return;
    const embeds = (await Promise.all(urls.map(unfurl))).filter((e): e is Embed => !!e);
    if (embeds.length === 0) return;
    if (!this.db.run("UPDATE messages SET embeds = ? WHERE id = ? AND content = ?", JSON.stringify(embeds), messageId, content).changes) return;
    const msg = this.store.message(messageId);
    const ref = msg && this.store.chanRef(msg.channelId);
    if (msg && ref) this.hub.toUsers(ref.guildId ? this.store.memberUserIds(ref.guildId) : this.store.dmMembers(ref.id), "message.update", msg);
  }

  // ---------- handlers ----------
  private handlers: { [M in ChatMethodName]: (userId: string, p: ReturnType<(typeof Methods)[M]["parse"]>) => MethodResults[M] | Promise<MethodResults[M]> } = {
    "me.update": (uid, p) => {
      if (p.nickname) {
        const taken = this.db.get<{ id: string }>("SELECT id FROM users WHERE nickname = ? AND id <> ?", p.nickname, uid);
        if (taken) fail("conflict", "Bu kullanıcı adı alınmış.");
        this.db.run("UPDATE users SET nickname = ? WHERE id = ?", p.nickname, uid);
      }
      if (p.status) this.db.run("UPDATE users SET status = ? WHERE id = ?", p.status, uid);
      const row = this.store.userRow(uid)!;
      this.hub.toUsers(this.store.relatedUserIds(uid), "user.update", this.store.publicUser(row), uid);
      return this.store.selfUser(row);
    },

    "guild.create": (uid, p) => {
      if (this.store.userRow(uid)?.guest === 1) fail("forbidden", "Misafirler sunucu oluşturamaz.");
      const gid = newId();
      const now = Date.now();
      this.db.tx(() => {
        this.db.run("INSERT INTO guilds (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)", gid, p.name, uid, now);
        this.db.run("INSERT INTO roles (id, guild_id, name, perms, position, is_default) VALUES (?, ?, '@herkes', ?, 0, 1)", newId(), gid, DEFAULT_ROLE_PERMS.member);
        this.db.run("INSERT INTO roles (id, guild_id, name, color, perms, position) VALUES (?, ?, 'Yönetici', '#FF7A45', ?, 1)", newId(), gid, DEFAULT_ROLE_PERMS.admin);
        this.db.run("INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)", gid, uid, now);
        this.db.run("INSERT INTO channels (id, guild_id, name, kind, position, created_at) VALUES (?, ?, 'genel', 'text', 0, ?)", newId(), gid, now);
        this.db.run("INSERT INTO channels (id, guild_id, name, kind, position, created_at) VALUES (?, ?, 'sohbet', 'voice', 0, ?)", newId(), gid, now);
      });
      return this.sendGuildAdd(gid, uid);
    },

    "guild.update": (uid, p) => {
      this.need(p.guildId, uid, P.MANAGE_GUILD);
      if (p.name) this.db.run("UPDATE guilds SET name = ? WHERE id = ?", p.name, p.guildId);
      const g = this.store.guild(p.guildId)!;
      this.hub.toUsers(this.store.memberUserIds(p.guildId), "guild.update", g);
      return g;
    },

    "guild.delete": (uid, p) => {
      const g = this.store.guild(p.guildId);
      if (!g || !this.store.isMember(p.guildId, uid)) fail("not_found", "Sunucu bulunamadı.");
      if (g!.ownerId !== uid) fail("forbidden", "Sunucuyu yalnızca sahibi silebilir.");
      const members = this.store.memberUserIds(p.guildId);
      const files = this.db.all<{ stored: string }>(
        "SELECT a.stored FROM attachments a JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = ?",
        p.guildId,
      ).map((r) => r.stored);
      this.media?.closeWhere((r) => r.guildId === p.guildId);
      this.db.run("DELETE FROM guilds WHERE id = ?", p.guildId);
      this.deleteFiles(files);
      this.hub.toUsers(members, "guild.remove", { guildId: p.guildId });
      return null;
    },

    "guild.leave": (uid, p) => {
      const g = this.store.guild(p.guildId);
      if (!g || !this.store.isMember(p.guildId, uid)) fail("not_found", "Sunucu bulunamadı.");
      if (g!.ownerId === uid) fail("bad_request", "Sunucu sahibi ayrılamaz; sunucuyu silebilirsin.");
      this.media?.evict(p.guildId, uid);
      this.db.run("DELETE FROM members WHERE guild_id = ? AND user_id = ?", p.guildId, uid);
      this.hub.toUser(uid, "guild.remove", { guildId: p.guildId });
      this.hub.toUsers(this.store.memberUserIds(p.guildId), "member.remove", { guildId: p.guildId, userId: uid });
      return null;
    },

    "channel.create": (uid, p) => {
      this.need(p.guildId, uid, P.MANAGE_CHANNELS);
      const count = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM channels WHERE guild_id = ?", p.guildId)!.n;
      if (count >= 200) fail("bad_request", "Kanal sınırına ulaşıldı.");
      const pos = this.db.get<{ p: number | null }>("SELECT MAX(position) AS p FROM channels WHERE guild_id = ? AND kind = ?", p.guildId, p.kind)!.p ?? -1;
      const id = newId();
      this.db.run("INSERT INTO channels (id, guild_id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, p.guildId, p.name, p.kind, pos + 1, Date.now());
      const ch = this.store.channel(id)!;
      this.hub.toUsers(this.store.memberUserIds(p.guildId), "channel.create", ch);
      return ch;
    },

    "channel.update": (uid, p) => {
      const ch = this.channelOf(p.channelId, uid, P.MANAGE_CHANNELS);
      if (p.name !== undefined) this.db.run("UPDATE channels SET name = ? WHERE id = ?", p.name, ch.id);
      if (p.topic !== undefined) this.db.run("UPDATE channels SET topic = ? WHERE id = ?", p.topic, ch.id);
      const out = this.store.channel(ch.id)!;
      this.hub.toUsers(this.store.memberUserIds(ch.guildId), "channel.update", out);
      return out;
    },

    "channel.delete": (uid, p) => {
      const ch = this.channelOf(p.channelId, uid, P.MANAGE_CHANNELS);
      const files = this.db.all<{ stored: string }>(
        "SELECT a.stored FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?", ch.id,
      ).map((r) => r.stored);
      this.media?.closeWhere((r) => r.channelId === ch.id);
      this.db.run("DELETE FROM channels WHERE id = ?", ch.id);
      this.deleteFiles(files);
      this.hub.toUsers(this.store.memberUserIds(ch.guildId), "channel.delete", { guildId: ch.guildId, channelId: ch.id });
      return null;
    },

    "dm.open": (uid, p) => {
      if (p.userId === uid) fail("bad_request", "Kendine mesaj gönderemezsin.");
      const other = this.store.userRow(p.userId);
      if (!other) fail("not_found", "Kullanıcı bulunamadı.");
      let id = this.store.dmBetween(uid, p.userId);
      if (!id) {
        if (!this.store.shareGuild(uid, p.userId)) fail("forbidden", "Yalnızca aynı sunucudaki kişilere mesaj gönderebilirsin.");
        id = newId();
        this.db.tx(() => {
          this.db.run("INSERT INTO channels (id, guild_id, name, kind, created_at) VALUES (?, NULL, '', 'dm', ?)", id!, Date.now());
          this.db.run("INSERT INTO dm_members (channel_id, user_id) VALUES (?, ?), (?, ?)", id!, uid, id!, p.userId);
        });
        const dm = this.store.dm(id)!;
        const users = [this.store.publicUser(this.store.userRow(uid)!), this.store.publicUser(other!)];
        this.hub.toUsers([uid, p.userId], "dm.create", { dm, users });
      }
      return this.store.dm(id)!;
    },

    "message.list": (uid, p) => {
      const ch = this.chatChannel(p.channelId, uid, P.VIEW_CHANNELS);
      return this.store.messages(ch.id, p.before, p.limit ?? LIMITS.messagePage);
    },

    "message.send": (uid, p) => {
      const ch = this.chatChannel(p.channelId, uid, P.SEND_MESSAGES);
      const content = p.content.trim();
      const attIds = [...new Set(p.attachmentIds ?? [])];
      if (!content && attIds.length === 0) fail("bad_request", "Boş mesaj gönderilemez.");
      if (attIds.length > 0 && !has(ch.perms, P.ATTACH_FILES)) fail("forbidden", "Dosya gönderme yetkin yok.");
      if (p.replyTo && !this.db.get("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?", p.replyTo, ch.id)) fail("not_found", "Yanıtlanan mesaj bulunamadı.");
      const id = newId();
      this.db.tx(() => {
        this.db.run(
          "INSERT INTO messages (id, channel_id, author_id, content, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          id, ch.id, uid, content, p.replyTo ?? null, Date.now(),
        );
        for (const a of attIds) {
          const ok = this.db.run("UPDATE attachments SET message_id = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL", id, a, uid).changes;
          if (!ok) fail("bad_request", "Dosya eki bulunamadı ya da zaten kullanılmış.");
        }
        this.db.run(
          "INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id",
          uid, ch.id, id,
        );
      });
      const msg = { ...this.store.message(id)!, nonce: p.nonce };
      this.hub.toUsers(ch.audience, "message.create", msg);
      void this.attachEmbeds(id, content);
      return msg;
    },

    "message.edit": (uid, p) => {
      const m = this.store.message(p.messageId);
      if (!m) fail("not_found", "Mesaj bulunamadı.");
      if (m!.authorId !== uid) fail("forbidden", "Yalnızca kendi mesajını düzenleyebilirsin.");
      const ch = this.chatChannel(m!.channelId, uid, P.VIEW_CHANNELS);
      const content = p.content.trim();
      this.db.run("UPDATE messages SET content = ?, edited_at = ?, embeds = '[]' WHERE id = ?", content, Date.now(), m!.id);
      const out = this.store.message(m!.id)!;
      this.hub.toUsers(ch.audience, "message.update", out);
      void this.attachEmbeds(out.id, content);
      return out;
    },

    "message.delete": (uid, p) => {
      const m = this.store.message(p.messageId);
      if (!m) fail("not_found", "Mesaj bulunamadı.");
      const ch = this.chatChannel(m!.channelId, uid, P.VIEW_CHANNELS);
      if (m!.authorId !== uid && !has(ch.perms, P.MANAGE_MESSAGES)) fail("forbidden", "Bu mesajı silme yetkin yok.");
      const files = this.db.all<{ stored: string }>("SELECT stored FROM attachments WHERE message_id = ?", m!.id).map((r) => r.stored);
      this.db.run("DELETE FROM messages WHERE id = ?", m!.id);
      this.deleteFiles(files);
      this.hub.toUsers(ch.audience, "message.delete", { channelId: ch.id, messageId: m!.id });
      return null;
    },

    typing: (uid, p) => {
      const ch = this.chatChannel(p.channelId, uid, P.SEND_MESSAGES);
      const key = `${uid}:${ch.id}`;
      const now = Date.now();
      if (now - (this.typingAt.get(key) ?? 0) < 2500) return null;
      this.typingAt.set(key, now);
      this.hub.toUsers(ch.audience, "typing", { channelId: ch.id, userId: uid }, uid);
      return null;
    },

    "read.mark": (uid, p) => {
      this.chatChannel(p.channelId, uid, P.VIEW_CHANNELS);
      this.db.run(
        `INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id WHERE excluded.last_read_id > read_states.last_read_id`,
        uid, p.channelId, p.messageId,
      );
      return null;
    },

    "invite.create": (uid, p) => {
      this.need(p.guildId, uid, P.CREATE_INVITES);
      let code = inviteCode();
      while (this.db.get("SELECT 1 FROM invites WHERE code = ?", code)) code = inviteCode();
      const expiresAt = p.expiresInHours ? Date.now() + p.expiresInHours * 3600_000 : null;
      this.db.run(
        "INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        code, p.guildId, uid, p.maxUses ?? null, expiresAt, Date.now(),
      );
      return { code, guildId: p.guildId, uses: 0, maxUses: p.maxUses ?? null, expiresAt };
    },

    "invite.join": (uid, p) => {
      const inv = this.store.invite(p.code);
      if (!inv || inv.expired) fail("not_found", "Davet geçersiz veya süresi dolmuş.");
      const gid = inv!.guildId;
      if (this.db.get("SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?", gid, uid)) fail("forbidden", "Bu sunucudan yasaklandın.");
      if (this.store.isMember(gid, uid)) return this.sendGuildAdd(gid, uid);
      this.db.tx(() => {
        this.db.run("INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)", gid, uid, Date.now());
        this.db.run("UPDATE invites SET uses = uses + 1 WHERE code = ?", inv!.code);
      });
      const user = this.store.publicUser(this.store.userRow(uid)!);
      this.hub.toUsers(this.store.memberUserIds(gid), "member.add", { member: this.store.member(gid, uid)!, user }, uid);
      return this.sendGuildAdd(gid, uid);
    },

    "role.create": (uid, p) => {
      const myPerms = this.need(p.guildId, uid, P.MANAGE_ROLES);
      const perms = p.perms ?? 0;
      if (!has(myPerms, P.ADMINISTRATOR) && (perms & ~myPerms) !== 0) fail("forbidden", "Sahip olmadığın yetkileri veremezsin.");
      const top = this.topPosition(p.guildId, uid);
      const max = this.db.get<{ p: number | null }>("SELECT MAX(position) AS p FROM roles WHERE guild_id = ?", p.guildId)!.p ?? 0;
      const position = Number.isFinite(top) ? Math.max(1, top - 1) : max + 1;
      const id = newId();
      this.db.run("INSERT INTO roles (id, guild_id, name, color, perms, position) VALUES (?, ?, ?, ?, ?, ?)", id, p.guildId, p.name, p.color ?? null, perms, position);
      const role = this.store.role(id)!;
      this.hub.toUsers(this.store.memberUserIds(p.guildId), "role.create", role);
      return role;
    },

    "role.update": (uid, p) => {
      const role = this.store.role(p.roleId);
      if (!role) fail("not_found", "Rol bulunamadı.");
      const myPerms = this.need(role!.guildId, uid, P.MANAGE_ROLES);
      if (role!.position >= this.topPosition(role!.guildId, uid)) fail("forbidden", "Bu rol senin rolünden yüksek.");
      if (p.perms !== undefined && !has(myPerms, P.ADMINISTRATOR) && (p.perms & ~myPerms) !== 0) fail("forbidden", "Sahip olmadığın yetkileri veremezsin.");
      if (p.name !== undefined && !role!.isDefault) this.db.run("UPDATE roles SET name = ? WHERE id = ?", p.name, role!.id);
      if (p.color !== undefined) this.db.run("UPDATE roles SET color = ? WHERE id = ?", p.color, role!.id);
      if (p.perms !== undefined) this.db.run("UPDATE roles SET perms = ? WHERE id = ?", p.perms, role!.id);
      const out = this.store.role(role!.id)!;
      this.hub.toUsers(this.store.memberUserIds(out.guildId), "role.update", out);
      this.pushPerms(out.guildId);
      return out;
    },

    "role.delete": (uid, p) => {
      const role = this.store.role(p.roleId);
      if (!role) fail("not_found", "Rol bulunamadı.");
      this.need(role!.guildId, uid, P.MANAGE_ROLES);
      if (role!.isDefault) fail("bad_request", "Varsayılan rol silinemez.");
      if (role!.position >= this.topPosition(role!.guildId, uid)) fail("forbidden", "Bu rol senin rolünden yüksek.");
      this.db.run("DELETE FROM roles WHERE id = ?", role!.id);
      this.hub.toUsers(this.store.memberUserIds(role!.guildId), "role.delete", { guildId: role!.guildId, roleId: role!.id });
      this.pushPerms(role!.guildId);
      return null;
    },

    "member.setRoles": (uid, p) => {
      this.need(p.guildId, uid, P.MANAGE_ROLES);
      const g = this.store.guild(p.guildId)!;
      if (!this.store.isMember(p.guildId, p.userId)) fail("not_found", "Üye bulunamadı.");
      if (g.ownerId === p.userId && uid !== g.ownerId) fail("forbidden", "Sunucu sahibinin rolleri değiştirilemez.");
      const top = this.topPosition(p.guildId, uid);
      const current = this.store.member(p.guildId, p.userId)!.roleIds;
      const roles = this.store.roles(p.guildId);
      const wanted = new Set(p.roleIds);
      for (const rid of new Set([...current, ...wanted])) {
        const r = roles.find((x) => x.id === rid);
        if (!r || r.isDefault) fail("bad_request", "Geçersiz rol.");
        const changed = current.includes(rid) !== wanted.has(rid);
        if (changed && r!.position >= top) fail("forbidden", `"${r!.name}" rolünü yönetemezsin.`);
      }
      this.db.tx(() => {
        this.db.run("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?", p.guildId, p.userId);
        for (const rid of wanted) this.db.run("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)", p.guildId, p.userId, rid);
      });
      const m = this.store.member(p.guildId, p.userId)!;
      this.hub.toUsers(this.store.memberUserIds(p.guildId), "member.update", m);
      this.hub.toUser(p.userId, "perms.update", { guildId: p.guildId, myPerms: this.store.perms(p.guildId, p.userId) });
      return m;
    },

    "member.kick": (uid, p) => this.removeMember(uid, p.guildId, p.userId, false),
    "member.ban": (uid, p) => this.removeMember(uid, p.guildId, p.userId, true),
  };

  private removeMember(uid: string, guildId: string, target: string, ban: boolean): null {
    this.need(guildId, uid, ban ? P.BAN_MEMBERS : P.KICK_MEMBERS);
    const g = this.store.guild(guildId)!;
    if (target === uid) fail("bad_request", "Kendini atamazsın.");
    if (target === g.ownerId) fail("forbidden", "Sunucu sahibi atılamaz.");
    if (!this.store.isMember(guildId, target)) fail("not_found", "Üye bulunamadı.");
    if (this.topPosition(guildId, target) >= this.topPosition(guildId, uid)) fail("forbidden", "Bu üyenin rolü seninkinden yüksek veya eşit.");
    this.media?.evict(guildId, target);
    this.db.tx(() => {
      this.db.run("DELETE FROM members WHERE guild_id = ? AND user_id = ?", guildId, target);
      if (ban) this.db.run("INSERT OR IGNORE INTO bans (guild_id, user_id, created_at) VALUES (?, ?, ?)", guildId, target, Date.now());
    });
    this.hub.toUser(target, "guild.remove", { guildId });
    this.hub.toUsers(this.store.memberUserIds(guildId), "member.remove", { guildId, userId: target });
    return null;
  }
}
