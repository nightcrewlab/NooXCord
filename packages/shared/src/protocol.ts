import type { z } from "zod";
import type { Methods } from "./schemas";
import type {
  Channel, ConsumerParams, DmChannel, Guild, GuildState, Invite, Member, Message, PublicUser, ReadyPayload, RemoteInputEvent, RemoteProducer, Role, SelfUser,
  VoiceJoinResult, VoiceState,
} from "./models";

/*
 * Realtime protocol over one WebSocket per host (/ws).
 *   client -> server  request : { t: "req", id, m: method, d: params }
 *   server -> client  response: { t: "res", id, ok: true, d } | { t: "res", id, ok: false, e: { code, msg } }
 *   server -> client  event   : { t: "evt", e: eventName, d }
 * First client frame must be { t: "auth", d: { token } }. The server answers with the "ready" event.
 * Both sides ping every 2 s ({ t: "ping" } / { t: "pong" }) so tunnels never see an idle socket.
 */

export const LIMITS = {
  nicknameMin: 2,
  nicknameMax: 32,
  passwordMin: 8,
  guildNameMax: 64,
  channelNameMax: 48,
  topicMax: 512,
  messageMax: 4000,
  attachmentsPerMessage: 10,
  uploadMaxBytes: 50 * 1024 * 1024,
  avatarMaxBytes: 2 * 1024 * 1024,
  messagePage: 50,
  thumbnailMaxBytes: 300 * 1024,
  remoteBatch: 64,
  /** Remote control ends after this long without input (CLAUDE.md §7.3). */
  remoteIdleMs: 10 * 60_000,
} as const;

/** Screen share quality presets (CLAUDE.md §6.2). "source" uses the monitor's own size. */
export const STREAM_PRESETS = {
  low: { width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  standard: { width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  smooth: { width: 1920, height: 1080, fps: 60, bitrate: 7_000_000 },
  high: { width: 2560, height: 1440, fps: 60, bitrate: 10_000_000 },
  source: { width: 0, height: 0, fps: 60, bitrate: 12_000_000 },
} as const;
export type StreamPreset = keyof typeof STREAM_PRESETS;

export interface AuthResponse { token: string; user: SelfUser }

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]>;
/** Methods handled by the media (voice/stream) service instead of the chat API. */
export type MediaMethodName = Extract<MethodName, `voice.${string}` | `media.${string}` | `stream.${string}` | `remote.${string}`>;
export type ChatMethodName = Exclude<MethodName, MediaMethodName>;

export interface MethodResults {
  "me.update": SelfUser;
  "guild.create": GuildState;
  "guild.update": Guild;
  "guild.delete": null;
  "guild.leave": null;
  "channel.create": Channel;
  "channel.update": Channel;
  "channel.delete": null;
  "message.list": Message[];
  "message.send": Message;
  "message.edit": Message;
  "message.delete": null;
  typing: null;
  "read.mark": null;
  "invite.create": Invite;
  "invite.join": GuildState;
  "dm.open": DmChannel;
  "role.create": Role;
  "role.update": Role;
  "role.delete": null;
  "member.setRoles": Member;
  "member.kick": null;
  "member.ban": null;
  "voice.join": VoiceJoinResult;
  "voice.leave": null;
  "voice.update": VoiceState;
  "voice.speaking": null;
  "media.connect": null;
  "media.produce": { id: string };
  "media.pauseProducer": null;
  "media.closeProducer": null;
  "media.consume": ConsumerParams;
  "media.resume": null;
  "media.closeConsumer": null;
  "media.layers": null;
  "stream.start": VoiceState;
  "stream.stop": null;
  "stream.watch": RemoteProducer[];
  "remote.request": null;
  "remote.respond": null;
  "remote.stop": null;
}

// ---------- Server events ----------
export interface Events {
  ready: ReadyPayload;
  "guild.add": { state: GuildState; users: PublicUser[] }; // you joined / created a guild
  "guild.update": Guild;
  "guild.remove": { guildId: string }; // deleted, left, kicked or banned
  "channel.create": Channel;
  "channel.update": Channel;
  "channel.delete": { guildId: string; channelId: string };
  "role.create": Role;
  "role.update": Role;
  "role.delete": { guildId: string; roleId: string };
  "member.add": { member: Member; user: PublicUser };
  "member.update": Member;
  "member.remove": { guildId: string; userId: string };
  "message.create": Message;
  /** A DM conversation now exists (you opened it or someone wrote to you). */
  "dm.create": { dm: DmChannel; users: PublicUser[] };
  "message.update": Message;
  "message.delete": { channelId: string; messageId: string };
  typing: { channelId: string; userId: string };
  "user.update": PublicUser;
  "perms.update": { guildId: string; myPerms: number };
  "voice.state": VoiceState; // joined or changed (mute, stream, viewers)
  "voice.leave": { guildId: string; channelId: string; userId: string };
  "voice.speaking": { channelId: string; userIds: string[] };
  /** Your voice session ended on the server (other device joined, kicked, channel deleted). */
  "voice.ended": { reason: "replaced" | "removed" | "error" };
  "media.producer": RemoteProducer & { channelId: string };
  "media.producerClosed": { producerId: string };
  "media.producerPaused": { producerId: string; paused: boolean };
  "media.consumerClosed": { consumerId: string };
  /** Someone watching your stream asks to control it. */
  "remote.request": { userId: string };
  /** The streamer answered your control request. */
  "remote.answer": { streamerId: string; allow: boolean };
  /** Input from your current controller (streamer side only). */
  "remote.input": { from: string; ev: RemoteInputEvent[] };
}
export type EventName = keyof Events;

export type ClientFrame =
  | { t: "auth"; d: { token: string; client?: "desktop" | "web" } }
  /** Remote-control input for the stream of user `to` (no response; rate limited separately). */
  | { t: "rc"; to: string; ev: RemoteInputEvent[] }
  | { t: "req"; id: number; m: MethodName; d: unknown }
  | { t: "ping" }
  | { t: "pong" };

export type ServerFrame =
  | { t: "res"; id: number; ok: true; d: unknown }
  | { t: "res"; id: number; ok: false; e: { code: ErrorCode; msg: string } }
  | { t: "evt"; e: EventName; d: unknown }
  | { t: "ping" }
  | { t: "pong" };

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

/** WebSocket close codes used by the host. */
export const CLOSE = { AUTH_FAILED: 4001, AUTH_TIMEOUT: 4002, REPLACED: 4003 } as const;
