/** Entity shapes sent over the wire. IDs are lexicographically time-sortable strings. */

export type UserStatus = "online" | "idle" | "dnd" | "invisible";

export interface PublicUser {
  id: string;
  nickname: string;
  avatar: string | null; // URL path relative to host, e.g. /avatars/abc.webp
  status: UserStatus;
  online: boolean;
  guest: boolean;
}

export interface SelfUser extends PublicUser {
  email: string | null;
}

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  createdAt: number;
}

export type ChannelKind = "text" | "voice";

export interface Channel {
  id: string;
  guildId: string;
  name: string;
  kind: ChannelKind;
  topic: string;
  position: number;
  lastMessageId: string | null;
}

export interface Role {
  id: string;
  guildId: string;
  name: string;
  color: string | null;
  perms: number;
  position: number;
  isDefault: boolean;
}

export interface Member {
  guildId: string;
  userId: string;
  roleIds: string[];
  joinedAt: number;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  width: number | null;
  height: number | null;
}

export interface Embed {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  replyTo: string | null;
  attachments: Attachment[];
  embeds: Embed[];
  createdAt: number;
  editedAt: number | null;
  nonce?: string;
}

export interface Invite {
  code: string;
  guildId: string;
  uses: number;
  maxUses: number | null;
  expiresAt: number | null;
}

/** Everything the client needs to render one guild. */
export interface GuildState {
  guild: Guild;
  channels: Channel[];
  roles: Role[];
  members: Member[];
  myPerms: number;
  /** Who is in which voice channel right now. */
  voice: VoiceState[];
}

// ---------- voice & streaming ----------
export type MediaSource = "mic" | "screen" | "screen-audio" | "camera";

export interface StreamInfo {
  startedAt: number;
  width: number;
  height: number;
  fps: number;
  audio: boolean;
  /** One-off JPEG preview captured when the stream started (host-relative URL). */
  thumbnail: string | null;
  viewers: string[];
  /** Viewer currently controlling this stream's keyboard/mouse (CLAUDE.md §7). */
  controllerId: string | null;
  /** The streamer runs the desktop app (SendInput), so viewers may ask for control. */
  controllable: boolean;
}

/**
 * Remote-control input, coordinates normalised to the shared surface (0..1).
 *  m: move · b: mouse button (0 left, 1 middle, 2 right, 3 back, 4 forward) · w: wheel (120 = one notch, +dy up)
 *  k: key by KeyboardEvent.code
 */
export type RemoteInputEvent =
  | { k: "m"; x: number; y: number }
  | { k: "b"; b: number; d: boolean }
  | { k: "w"; dx: number; dy: number }
  | { k: "k"; c: string; d: boolean };

export interface VoiceState {
  userId: string;
  guildId: string;
  channelId: string;
  muted: boolean;
  deafened: boolean;
  /** Muted by the server (no SPEAK permission). */
  suppressed: boolean;
  joinedAt: number;
  stream: StreamInfo | null;
  /** Camera on (sent automatically to everyone in the channel, unlike screen streams). */
  camera: boolean;
}

/** A producer another participant is sending. */
export interface RemoteProducer {
  id: string;
  userId: string;
  source: MediaSource;
  kind: "audio" | "video";
  paused: boolean;
}

/** WebRTC transport parameters (mediasoup shapes, opaque to shared code). */
export interface TransportParams {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown[];
  dtlsParameters: unknown;
  sctpParameters?: unknown;
}

export interface VoiceJoinResult {
  state: VoiceState;
  rtpCapabilities: unknown;
  /** WebRTC mode only. */
  send: TransportParams | null;
  recv: TransportParams | null;
  producers: RemoteProducer[];
  /** Tunnel mode (NXM-WS): one-time ticket for the /media WebSocket. */
  wsTicket: string | null;
}

export interface ConsumerParams {
  id: string;
  producerId: string;
  userId: string;
  source: MediaSource;
  kind: "audio" | "video";
  rtpParameters: unknown;
  /** Tunnel mode: tag of this consumer's frames on the /media socket. */
  tag: number | null;
}

/** Direct-message conversation between two users (not part of any guild). */
export interface DmChannel {
  id: string;
  userIds: string[];
  lastMessageId: string | null;
}

export interface ReadyPayload {
  user: SelfUser;
  users: PublicUser[];
  guilds: GuildState[];
  dms: DmChannel[];
  readStates: Record<string, string>; // channelId -> last read message id
  host: HostInfo;
}

export interface HostInfo {
  name: string;
  version: string;
  allowRegistration: boolean;
  allowGuests: boolean;
  /** Guests must enter the host's guest password. */
  guestPassword: boolean;
}
