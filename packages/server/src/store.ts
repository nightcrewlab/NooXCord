import {
  ALL_PERMISSIONS, DEFAULT_ROLE_PERMS, GUEST_FORBIDDEN,
  type Attachment, type Channel, type DmChannel, type Embed, type Guild, type GuildState, type Invite, type Member,
  type Message, type PublicUser, type Role, type SelfUser, type UserStatus, type VoiceState,
} from "@nooxcord/shared";
import type { Db } from "./db";

/* Row shapes (snake_case as in SQL). */
export interface UserRow { id: string; nickname: string; email: string | null; pass_hash: string | null; avatar: string | null; status: string; guest: number; created_at: number }
interface GuildRow { id: string; name: string; icon: string | null; owner_id: string; created_at: number }
interface ChannelRow { id: string; guild_id: string; name: string; kind: "text" | "voice"; topic: string; position: number; last_id?: string | null }
interface RoleRow { id: string; guild_id: string; name: string; color: string | null; perms: number; position: number; is_default: number }
interface MessageRow { id: string; channel_id: string; author_id: string; content: string; reply_to: string | null; embeds: string; created_at: number; edited_at: number | null }
interface AttachmentRow { id: string; message_id: string | null; name: string; mime: string; size: number; width: number | null; height: number | null }
interface InviteRow { code: string; guild_id: string; uses: number; max_uses: number | null; expires_at: number | null }

/** Read-side helpers that map rows to wire models. Writes live in services. */
export class Store {
  /** Live voice states per guild; provided by the media service. */
  voiceOf: (guildId: string) => VoiceState[] = () => [];

  constructor(readonly db: Db, private isOnline: (userId: string) => boolean) {}

  // ---------- users ----------
  userRow(id: string): UserRow | undefined {
    return this.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
  }

  publicUser(row: UserRow): PublicUser {
    const online = this.isOnline(row.id) && row.status !== "invisible";
    return {
      id: row.id,
      nickname: row.nickname,
      avatar: row.avatar,
      status: (online ? row.status : "online") as UserStatus,
      online,
      guest: row.guest === 1,
    };
  }

  selfUser(row: UserRow): SelfUser {
    return { ...this.publicUser(row), status: row.status as UserStatus, online: true, email: row.email };
  }

  /** Users that share at least one guild or a DM with userId (including userId). */
  relatedUserIds(userId: string): string[] {
    return this.db
      .all<{ user_id: string }>(
        `SELECT m2.user_id FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ?1
         UNION SELECT d2.user_id FROM dm_members d1 JOIN dm_members d2 ON d1.channel_id = d2.channel_id WHERE d1.user_id = ?1`,
        userId,
      )
      .map((r) => r.user_id);
  }

  /** Users this user should know about: guild co-members and DM partners. */
  usersFor(userId: string): PublicUser[] {
    const ids = this.relatedUserIds(userId);
    if (ids.length === 0) return [];
    return this.db.all<UserRow>(`SELECT * FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map((r) => this.publicUser(r));
  }

  // ---------- direct messages ----------
  dmsOf(userId: string): DmChannel[] {
    const rows = this.db.all<{ id: string; last_id: string | null }>(
      `SELECT c.id, (SELECT MAX(id) FROM messages WHERE channel_id = c.id) AS last_id
       FROM channels c JOIN dm_members d ON d.channel_id = c.id WHERE c.kind = 'dm' AND d.user_id = ?`,
      userId,
    );
    return rows.map((r) => ({ id: r.id, userIds: this.dmMembers(r.id), lastMessageId: r.last_id ?? null }));
  }

  dmMembers(channelId: string): string[] {
    return this.db.all<{ user_id: string }>("SELECT user_id FROM dm_members WHERE channel_id = ? ORDER BY user_id", channelId).map((r) => r.user_id);
  }

  dm(channelId: string): DmChannel | undefined {
    const r = this.db.get<{ id: string; last_id: string | null }>(
      "SELECT c.id, (SELECT MAX(id) FROM messages WHERE channel_id = c.id) AS last_id FROM channels c WHERE c.id = ? AND c.kind = 'dm'",
      channelId,
    );
    return r && { id: r.id, userIds: this.dmMembers(r.id), lastMessageId: r.last_id ?? null };
  }

  dmBetween(a: string, b: string): string | undefined {
    return this.db.get<{ channel_id: string }>(
      "SELECT d1.channel_id FROM dm_members d1 JOIN dm_members d2 ON d1.channel_id = d2.channel_id WHERE d1.user_id = ? AND d2.user_id = ?",
      a, b,
    )?.channel_id;
  }

  shareGuild(a: string, b: string): boolean {
    return !!this.db.get("SELECT 1 FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ? AND m2.user_id = ?", a, b);
  }

  /** Guild channel or DM: who may see it and which guild (null for DMs) its permissions come from. */
  chanRef(id: string): { id: string; guildId: string | null; kind: string } | undefined {
    const r = this.db.get<{ id: string; guild_id: string | null; kind: string }>("SELECT id, guild_id, kind FROM channels WHERE id = ?", id);
    return r && { id: r.id, guildId: r.guild_id, kind: r.kind };
  }

  usersInGuilds(guildIds: string[]): PublicUser[] {
    if (guildIds.length === 0) return [];
    const rows = this.db.all<UserRow>(
      `SELECT DISTINCT u.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.guild_id IN (${guildIds.map(() => "?").join(",")})`,
      ...guildIds,
    );
    return rows.map((r) => this.publicUser(r));
  }

  // ---------- guilds ----------
  guild(id: string): Guild | undefined {
    const r = this.db.get<GuildRow>("SELECT * FROM guilds WHERE id = ?", id);
    return r && { id: r.id, name: r.name, icon: r.icon, ownerId: r.owner_id, createdAt: r.created_at };
  }

  guildIdsOf(userId: string): string[] {
    return this.db.all<{ guild_id: string }>("SELECT guild_id FROM members WHERE user_id = ? ORDER BY joined_at", userId).map((r) => r.guild_id);
  }

  memberUserIds(guildId: string): string[] {
    return this.db.all<{ user_id: string }>("SELECT user_id FROM members WHERE guild_id = ?", guildId).map((r) => r.user_id);
  }

  isMember(guildId: string, userId: string): boolean {
    return !!this.db.get("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?", guildId, userId);
  }

  channels(guildId: string): Channel[] {
    return this.db
      .all<ChannelRow>(
        `SELECT c.*, (SELECT MAX(id) FROM messages WHERE channel_id = c.id) AS last_id
         FROM channels c WHERE guild_id = ? ORDER BY kind DESC, position, id`,
        guildId,
      )
      .map(mapChannel);
  }

  channel(id: string): Channel | undefined {
    const r = this.db.get<ChannelRow>(
      "SELECT c.*, (SELECT MAX(id) FROM messages WHERE channel_id = c.id) AS last_id FROM channels c WHERE id = ? AND guild_id IS NOT NULL",
      id,
    );
    return r && mapChannel(r);
  }

  roles(guildId: string): Role[] {
    return this.db.all<RoleRow>("SELECT * FROM roles WHERE guild_id = ? ORDER BY position DESC, id", guildId).map(mapRole);
  }

  role(id: string): Role | undefined {
    const r = this.db.get<RoleRow>("SELECT * FROM roles WHERE id = ?", id);
    return r && mapRole(r);
  }

  members(guildId: string): Member[] {
    const rows = this.db.all<{ user_id: string; joined_at: number }>("SELECT user_id, joined_at FROM members WHERE guild_id = ?", guildId);
    const roleRows = this.db.all<{ user_id: string; role_id: string }>("SELECT user_id, role_id FROM member_roles WHERE guild_id = ?", guildId);
    const byUser = new Map<string, string[]>();
    for (const r of roleRows) (byUser.get(r.user_id) ?? byUser.set(r.user_id, []).get(r.user_id)!).push(r.role_id);
    return rows.map((r) => ({ guildId, userId: r.user_id, roleIds: byUser.get(r.user_id) ?? [], joinedAt: r.joined_at }));
  }

  member(guildId: string, userId: string): Member | undefined {
    const r = this.db.get<{ joined_at: number }>("SELECT joined_at FROM members WHERE guild_id = ? AND user_id = ?", guildId, userId);
    if (!r) return undefined;
    const roleIds = this.db.all<{ role_id: string }>("SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?", guildId, userId).map((x) => x.role_id);
    return { guildId, userId, roleIds, joinedAt: r.joined_at };
  }

  /** Effective guild-level permissions. Owner has everything; guests can never hold some bits. */
  perms(guildId: string, userId: string): number {
    const g = this.db.get<{ owner_id: string }>("SELECT owner_id FROM guilds WHERE id = ?", guildId);
    if (!g || !this.isMember(guildId, userId)) return 0;
    if (g.owner_id === userId) return ALL_PERMISSIONS;
    const guest = this.userRow(userId)?.guest === 1;
    let p = 0;
    for (const r of this.db.all<{ perms: number; is_default: number }>(
      `SELECT perms, is_default FROM roles WHERE guild_id = ?1 AND (is_default = 1 OR id IN (SELECT role_id FROM member_roles WHERE guild_id = ?1 AND user_id = ?2))`,
      guildId,
      userId,
    )) p |= guest && r.is_default ? r.perms & DEFAULT_ROLE_PERMS.guest : r.perms; // the host widens guests only with explicit roles
    if (guest) p &= ~GUEST_FORBIDDEN;
    return p;
  }

  guildState(guildId: string, userId: string): GuildState {
    const guild = this.guild(guildId);
    if (!guild) throw new Error("guild missing");
    return {
      guild,
      channels: this.channels(guildId),
      roles: this.roles(guildId),
      members: this.members(guildId),
      myPerms: this.perms(guildId, userId),
      voice: this.voiceOf(guildId),
    };
  }

  // ---------- messages ----------
  messages(channelId: string, before: string | undefined, limit: number): Message[] {
    const rows = before
      ? this.db.all<MessageRow>("SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?", channelId, before, limit)
      : this.db.all<MessageRow>("SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?", channelId, limit);
    rows.reverse();
    return this.hydrate(rows);
  }

  message(id: string): Message | undefined {
    const r = this.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
    return r && this.hydrate([r])[0];
  }

  private hydrate(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const atts = this.db.all<AttachmentRow>(
      `SELECT id, message_id, name, mime, size, width, height FROM attachments WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
      ...ids,
    );
    const byMsg = new Map<string, Attachment[]>();
    for (const a of atts) (byMsg.get(a.message_id!) ?? byMsg.set(a.message_id!, []).get(a.message_id!)!).push(mapAttachment(a));
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      authorId: r.author_id,
      content: r.content,
      replyTo: r.reply_to,
      attachments: byMsg.get(r.id) ?? [],
      embeds: JSON.parse(r.embeds) as Embed[],
      createdAt: r.created_at,
      editedAt: r.edited_at,
    }));
  }

  readStates(userId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.all<{ channel_id: string; last_read_id: string }>("SELECT channel_id, last_read_id FROM read_states WHERE user_id = ?", userId)) {
      out[r.channel_id] = r.last_read_id;
    }
    return out;
  }

  invite(code: string): (Invite & { expired: boolean }) | undefined {
    const r = this.db.get<InviteRow>("SELECT * FROM invites WHERE code = ?", code);
    if (!r) return undefined;
    const expired = (r.expires_at !== null && r.expires_at < Date.now()) || (r.max_uses !== null && r.uses >= r.max_uses);
    return { code: r.code, guildId: r.guild_id, uses: r.uses, maxUses: r.max_uses, expiresAt: r.expires_at, expired };
  }
}

function mapChannel(r: ChannelRow): Channel {
  return { id: r.id, guildId: r.guild_id, name: r.name, kind: r.kind, topic: r.topic, position: r.position, lastMessageId: r.last_id ?? null };
}
function mapRole(r: RoleRow): Role {
  return { id: r.id, guildId: r.guild_id, name: r.name, color: r.color, perms: r.perms, position: r.position, isDefault: r.is_default === 1 };
}
export function mapAttachment(a: AttachmentRow): Attachment {
  return { id: a.id, name: a.name, mime: a.mime, size: a.size, url: `/files/${a.id}/${encodeURIComponent(a.name)}`, width: a.width, height: a.height };
}
