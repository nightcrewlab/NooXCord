import { create } from "zustand";
import {
  LIMITS,
  type Channel, type DmChannel, type EventName, type Events, type GuildState, type HostInfo, type Message, type PublicUser, type SelfUser,
} from "@nooxcord/shared";
import { HostConnection, HostHttp, RpcError, type ConnStatus } from "../net/connection";
import { isEphemeralHost, platform } from "../platform";
import { t } from "../i18n";

export interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

/** Locally pending message (optimistic send). */
export interface PendingMessage extends Message {
  pending: true;
  failed?: boolean;
}

export type Screen = "hosts" | "auth" | "app";

/** selectedGuild value for the direct-message home (selectedChannel[DM_HOME] = open DM). */
export const DM_HOME = "@me";

interface Toast { id: number; text: string; kind: "info" | "error" }

interface State {
  screen: Screen;
  hostUrl: string | null;
  hostInfo: HostInfo | null;
  http: HostHttp | null;
  conn: HostConnection | null;
  connStatus: ConnStatus | "idle";

  me: SelfUser | null;
  users: Record<string, PublicUser>;
  guilds: Record<string, GuildState>;
  guildOrder: string[];
  dms: Record<string, DmChannel>;
  messages: Record<string, ChannelMessages>;
  pending: Record<string, PendingMessage[]>; // channelId -> pending
  readStates: Record<string, string>;
  typing: Record<string, Record<string, number>>; // channelId -> userId -> expiresAt
  speaking: Record<string, string[]>; // voice channelId -> userIds speaking (server-side detection)

  selectedGuild: string | null;
  selectedChannel: Record<string, string>; // guildId -> channelId
  showMembers: boolean;
  toasts: Toast[];
}

interface Actions {
  openHost(url: string): Promise<void>;
  /** Same host, another address (e.g. its tunnel): keeps the session token and the open channel. */
  switchAddress(url: string): Promise<void>;
  leaveHost(): Promise<void>;
  authenticated(token: string, me: SelfUser): Promise<void>;
  logout(): Promise<void>;
  selectGuild(id: string | null): void;
  selectChannel(guildId: string, channelId: string): void;
  loadMessages(channelId: string, older?: boolean): Promise<void>;
  sendMessage(channelId: string, content: string, opts?: { replyTo?: string; attachmentIds?: string[]; preview?: Message["attachments"] }): Promise<void>;
  markRead(channelId: string): void;
  toggleMembers(): void;
  toast(text: string, kind?: Toast["kind"]): void;
  setMe(me: SelfUser): void;
  /** Opens (creating if needed) the DM with a user and shows it. */
  openDm(userId: string): Promise<void>;
}

export type Store = State & Actions;

const initial: State = {
  screen: "hosts",
  hostUrl: null,
  hostInfo: null,
  http: null,
  conn: null,
  connStatus: "idle",
  me: null,
  users: {},
  guilds: {},
  guildOrder: [],
  dms: {},
  messages: {},
  pending: {},
  readStates: {},
  typing: {},
  speaking: {},
  selectedGuild: null,
  selectedChannel: {},
  showMembers: true,
  toasts: [],
};

let toastSeq = 0;
let nonceSeq = 0;

export const useStore = create<Store>()((set, get) => {
  /** Applies one server event to the state. */
  function apply<E extends EventName>(e: E, raw: Events[E]): void {
    switch (e) {
      case "ready": {
        const d = raw as Events["ready"];
        const guilds: Record<string, GuildState> = {};
        for (const g of d.guilds) guilds[g.guild.id] = g;
        const users: Record<string, PublicUser> = {};
        for (const u of d.users) users[u.id] = u;
        users[d.user.id] = d.user;
        const order = d.guilds.map((g) => g.guild.id);
        const prev = get().selectedGuild;
        set({
          me: d.user, users, guilds, guildOrder: order, readStates: d.readStates, hostInfo: d.host,
          dms: Object.fromEntries((d.dms ?? []).map((x) => [x.id, x])),
          selectedGuild: prev && (guilds[prev] || prev === DM_HOME) ? prev : order[0] ?? null,
          // After a reconnect, cached channel pages may be stale: drop them and refetch on view.
          messages: {}, screen: "app", speaking: {},
        });
        break;
      }
      case "host.update":
        set({ hostInfo: raw as Events["host.update"] });
        break;
      case "guild.add": {
        const d = raw as Events["guild.add"];
        set((s) => ({
          guilds: { ...s.guilds, [d.state.guild.id]: d.state },
          guildOrder: s.guildOrder.includes(d.state.guild.id) ? s.guildOrder : [...s.guildOrder, d.state.guild.id],
          users: { ...s.users, ...Object.fromEntries(d.users.map((u) => [u.id, u])) },
        }));
        break;
      }
      case "guild.update": {
        const g = raw as Events["guild.update"];
        updGuild(g.id, (gs) => ({ ...gs, guild: g }));
        break;
      }
      case "guild.remove": {
        const { guildId } = raw as Events["guild.remove"];
        set((s) => {
          const guilds = { ...s.guilds };
          delete guilds[guildId];
          const guildOrder = s.guildOrder.filter((x) => x !== guildId);
          return { guilds, guildOrder, selectedGuild: s.selectedGuild === guildId ? guildOrder[0] ?? null : s.selectedGuild };
        });
        break;
      }
      case "channel.create":
      case "channel.update": {
        const ch = raw as Channel;
        updGuild(ch.guildId, (gs) => {
          const exists = gs.channels.some((c) => c.id === ch.id);
          const channels = exists ? gs.channels.map((c) => (c.id === ch.id ? { ...ch, lastMessageId: c.lastMessageId ?? ch.lastMessageId } : c)) : [...gs.channels, ch];
          return { ...gs, channels };
        });
        break;
      }
      case "channel.delete": {
        const d = raw as Events["channel.delete"];
        updGuild(d.guildId, (gs) => ({ ...gs, channels: gs.channels.filter((c) => c.id !== d.channelId) }));
        break;
      }
      case "role.create":
      case "role.update": {
        const r = raw as Events["role.update"];
        updGuild(r.guildId, (gs) => ({ ...gs, roles: gs.roles.some((x) => x.id === r.id) ? gs.roles.map((x) => (x.id === r.id ? r : x)) : [...gs.roles, r] }));
        break;
      }
      case "role.delete": {
        const d = raw as Events["role.delete"];
        updGuild(d.guildId, (gs) => ({
          ...gs,
          roles: gs.roles.filter((r) => r.id !== d.roleId),
          members: gs.members.map((m) => ({ ...m, roleIds: m.roleIds.filter((x) => x !== d.roleId) })),
        }));
        break;
      }
      case "member.add": {
        const d = raw as Events["member.add"];
        set((s) => ({ users: { ...s.users, [d.user.id]: d.user } }));
        updGuild(d.member.guildId, (gs) => ({ ...gs, members: [...gs.members.filter((m) => m.userId !== d.member.userId), d.member] }));
        break;
      }
      case "member.update": {
        const m = raw as Events["member.update"];
        updGuild(m.guildId, (gs) => ({ ...gs, members: gs.members.map((x) => (x.userId === m.userId ? m : x)) }));
        break;
      }
      case "member.remove": {
        const d = raw as Events["member.remove"];
        updGuild(d.guildId, (gs) => ({ ...gs, members: gs.members.filter((m) => m.userId !== d.userId) }));
        break;
      }
      case "perms.update": {
        const d = raw as Events["perms.update"];
        updGuild(d.guildId, (gs) => ({ ...gs, myPerms: d.myPerms }));
        break;
      }
      case "user.update": {
        const u = raw as PublicUser;
        set((s) => ({ users: { ...s.users, [u.id]: u }, me: s.me?.id === u.id ? { ...s.me, ...u, email: s.me.email } : s.me }));
        break;
      }
      case "dm.create": {
        const d = raw as Events["dm.create"];
        set((s) => ({
          dms: { ...s.dms, [d.dm.id]: d.dm },
          users: { ...Object.fromEntries(d.users.map((u) => [u.id, u])), ...s.users },
        }));
        break;
      }
      case "message.create": {
        const m = raw as Message;
        set((s) => {
          const out: Partial<State> = {};
          const cm = s.messages[m.channelId];
          if (cm?.loaded && !cm.items.some((x) => x.id === m.id)) out.messages = { ...s.messages, [m.channelId]: { ...cm, items: [...cm.items, m] } };
          if (m.nonce && s.pending[m.channelId]?.some((p) => p.nonce === m.nonce)) {
            out.pending = { ...s.pending, [m.channelId]: s.pending[m.channelId]!.filter((p) => p.nonce !== m.nonce) };
          }
          const typing = s.typing[m.channelId];
          if (typing?.[m.authorId]) {
            const tc = { ...typing };
            delete tc[m.authorId];
            out.typing = { ...s.typing, [m.channelId]: tc };
          }
          if (m.authorId === s.me?.id) out.readStates = { ...s.readStates, [m.channelId]: m.id };
          return out;
        });
        // bump lastMessageId for unread badges
        const dm = get().dms[m.channelId];
        if (dm) set((s) => ({ dms: { ...s.dms, [dm.id]: { ...dm, lastMessageId: m.id } } }));
        for (const gs of Object.values(get().guilds)) {
          if (gs.channels.some((c) => c.id === m.channelId)) {
            updGuild(gs.guild.id, (g) => ({ ...g, channels: g.channels.map((c) => (c.id === m.channelId ? { ...c, lastMessageId: m.id } : c)) }));
          }
        }
        break;
      }
      case "message.update": {
        const m = raw as Message;
        set((s) => {
          const cm = s.messages[m.channelId];
          if (!cm) return {};
          return { messages: { ...s.messages, [m.channelId]: { ...cm, items: cm.items.map((x) => (x.id === m.id ? m : x)) } } };
        });
        break;
      }
      case "message.delete": {
        const d = raw as Events["message.delete"];
        set((s) => {
          const cm = s.messages[d.channelId];
          if (!cm) return {};
          return { messages: { ...s.messages, [d.channelId]: { ...cm, items: cm.items.filter((x) => x.id !== d.messageId) } } };
        });
        break;
      }
      case "voice.state": {
        const v = raw as Events["voice.state"];
        // A user is in at most one voice channel: drop them from every guild first.
        for (const gs of Object.values(get().guilds)) {
          if (gs.guild.id !== v.guildId && gs.voice.some((x) => x.userId === v.userId)) updGuild(gs.guild.id, (g) => ({ ...g, voice: g.voice.filter((x) => x.userId !== v.userId) }));
        }
        updGuild(v.guildId, (g) => ({ ...g, voice: [...g.voice.filter((x) => x.userId !== v.userId), v] }));
        break;
      }
      case "voice.leave": {
        const d = raw as Events["voice.leave"];
        updGuild(d.guildId, (g) => ({ ...g, voice: g.voice.filter((x) => x.userId !== d.userId) }));
        set((s) => (s.speaking[d.channelId]?.includes(d.userId) ? { speaking: { ...s.speaking, [d.channelId]: s.speaking[d.channelId]!.filter((x) => x !== d.userId) } } : {}));
        break;
      }
      case "voice.speaking": {
        const d = raw as Events["voice.speaking"];
        set((s) => ({ speaking: { ...s.speaking, [d.channelId]: d.userIds } }));
        break;
      }
      case "typing": {
        const d = raw as Events["typing"];
        set((s) => ({ typing: { ...s.typing, [d.channelId]: { ...s.typing[d.channelId], [d.userId]: Date.now() + 6000 } } }));
        break;
      }
    }
  }

  function updGuild(id: string, fn: (g: GuildState) => GuildState) {
    set((s) => (s.guilds[id] ? { guilds: { ...s.guilds, [id]: fn(s.guilds[id]!) } } : {}));
  }

  function startConnection(http: HostHttp) {
    get().conn?.close();
    const conn = new HostConnection(http);
    conn.on(apply);
    conn.onStatus((st) => {
      // A replaced connection closes late: its "closed" must not overwrite the new connection's status.
      if (get().conn !== conn) return;
      set({ connStatus: st });
      if (st === "auth_failed") {
        void platform.hosts.setToken(http.base, null);
        http.token = null;
        set({ screen: "auth", conn: null, me: null });
        get().toast(t("conn.sessionExpired"), "error");
      }
    });
    set({ conn, connStatus: "connecting" });
    conn.connect();
  }

  return {
    ...initial,

    async openHost(url) {
      const http = new HostHttp(url);
      const info = await http.info(); // throws if unreachable
      // Quick-tunnel URLs change on every tunnel start: remembering one would make the next launch
      // land on a dead address instead of the stable LAN/Hamachi one the user came from.
      if (!isEphemeralHost(url)) {
        await platform.hosts.save({ url, name: info.name });
        await platform.hosts.setLast(url);
      }
      const token = await platform.hosts.getToken(url);
      set({ ...initial, hostUrl: url, hostInfo: info, http, screen: token ? "app" : "auth", showMembers: get().showMembers });
      if (token) {
        http.token = token;
        startConnection(http);
      }
    },

    async switchAddress(url) {
      const { hostUrl, selectedGuild, selectedChannel } = get();
      await new HostHttp(url).info(); // unreachable: stay where we are (throws)
      const token = hostUrl ? await platform.hosts.getToken(hostUrl) : null;
      if (token) await platform.hosts.setToken(url, token);
      get().conn?.close();
      await get().openHost(url);
      set({ selectedGuild, selectedChannel });
    },

    async leaveHost() {
      get().conn?.close();
      await platform.hosts.setLast(null);
      set({ ...initial, showMembers: get().showMembers });
    },

    async authenticated(token, me) {
      const { http, hostUrl } = get();
      if (!http || !hostUrl) return;
      http.token = token;
      await platform.hosts.setToken(hostUrl, token);
      set({ me });
      startConnection(http);
    },

    async logout() {
      const { http, hostUrl, conn } = get();
      conn?.close();
      await http?.logout().catch(() => {});
      if (hostUrl) await platform.hosts.setToken(hostUrl, null);
      if (http) http.token = null;
      set({ ...initial, hostUrl, http, hostInfo: get().hostInfo, screen: "auth" });
    },

    selectGuild(id) {
      set({ selectedGuild: id });
    },

    async openDm(userId) {
      const { conn } = get();
      if (!conn) return;
      try {
        const dm = await conn.call("dm.open", { userId });
        set((s) => ({ dms: { ...s.dms, [dm.id]: dm }, selectedGuild: DM_HOME, selectedChannel: { ...s.selectedChannel, [DM_HOME]: dm.id } }));
        window.dispatchEvent(new CustomEvent("nx:channel-open", { detail: "text" }));
      } catch (e) {
        get().toast((e as Error).message, "error");
      }
    },

    selectChannel(guildId, channelId) {
      set((s) => ({ selectedGuild: guildId, selectedChannel: { ...s.selectedChannel, [guildId]: channelId } }));
    },

    async loadMessages(channelId, older = false) {
      const { conn, messages } = get();
      const cur = messages[channelId];
      if (!conn || conn.status !== "ready" || cur?.loading || (older && cur && !cur.hasMore) || (!older && cur?.loaded)) return;
      set((s) => ({ messages: { ...s.messages, [channelId]: { items: cur?.items ?? [], hasMore: cur?.hasMore ?? true, loaded: cur?.loaded ?? false, loading: true } } }));
      try {
        const before = older ? cur?.items[0]?.id : undefined;
        const page = await conn.call("message.list", { channelId, before, limit: LIMITS.messagePage });
        set((s) => {
          const prev = s.messages[channelId]?.items ?? [];
          const items = older ? [...page, ...prev] : page;
          return { messages: { ...s.messages, [channelId]: { items, hasMore: page.length === LIMITS.messagePage, loading: false, loaded: true } } };
        });
      } catch (e) {
        set((s) => ({ messages: { ...s.messages, [channelId]: { ...(s.messages[channelId] ?? { items: [], hasMore: true, loaded: false }), loading: false } } }));
        get().toast((e as Error).message, "error");
      }
    },

    async sendMessage(channelId, content, opts = {}) {
      const { conn, me } = get();
      if (!conn || !me) return;
      const nonce = `${Date.now().toString(36)}-${++nonceSeq}`;
      const optimistic: PendingMessage = {
        id: `pending-${nonce}`, channelId, authorId: me.id, content, replyTo: opts.replyTo ?? null,
        attachments: opts.preview ?? [], embeds: [], createdAt: Date.now(), editedAt: null, nonce, pending: true,
      };
      set((s) => ({ pending: { ...s.pending, [channelId]: [...(s.pending[channelId] ?? []), optimistic] } }));
      try {
        await conn.call("message.send", { channelId, content, replyTo: opts.replyTo, attachmentIds: opts.attachmentIds, nonce });
        // the message.create event replaces the optimistic entry
      } catch (e) {
        set((s) => ({ pending: { ...s.pending, [channelId]: (s.pending[channelId] ?? []).map((p) => (p.nonce === nonce ? { ...p, failed: true } : p)) } }));
        get().toast(e instanceof RpcError ? e.message : t("err.sendFailed"), "error");
      }
    },

    markRead(channelId) {
      const { conn, readStates, guilds, dms } = get();
      let last: string | null = dms[channelId]?.lastMessageId ?? null;
      for (const g of Object.values(guilds)) {
        const c = g.channels.find((x) => x.id === channelId);
        if (c) last = c.lastMessageId;
      }
      if (!conn || !last || (readStates[channelId] ?? "") >= last) return;
      set((s) => ({ readStates: { ...s.readStates, [channelId]: last! } }));
      conn.call("read.mark", { channelId, messageId: last }).catch(() => {});
    },

    toggleMembers() {
      set((s) => ({ showMembers: !s.showMembers }));
    },

    toast(text, kind = "info") {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
      window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4000);
    },

    setMe(me) {
      set((s) => ({ me, users: { ...s.users, [me.id]: me } }));
    },
  };
});

// Expire typing indicators.
window.setInterval(() => {
  const { typing } = useStore.getState();
  const now = Date.now();
  let changed = false;
  const next: State["typing"] = {};
  for (const [ch, users] of Object.entries(typing)) {
    const kept = Object.fromEntries(Object.entries(users).filter(([, exp]) => exp > now));
    if (Object.keys(kept).length !== Object.keys(users).length) changed = true;
    if (Object.keys(kept).length) next[ch] = kept;
  }
  if (changed) useStore.setState({ typing: next });
}, 1000);

/** Selectors */
export const useGuild = (id: string | null) => useStore((s) => (id ? s.guilds[id] : undefined));
export const useHttp = () => useStore((s) => s.http);
