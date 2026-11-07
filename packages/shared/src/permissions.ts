/** Permission bits. Stored as an integer per role; a member's permissions are the OR of their roles. */
export const P = {
  VIEW_CHANNELS: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  ATTACH_FILES: 1 << 2,
  CONNECT_VOICE: 1 << 3,
  SPEAK: 1 << 4,
  STREAM: 1 << 5,
  REQUEST_REMOTE_CONTROL: 1 << 6,
  MANAGE_MESSAGES: 1 << 7,
  MANAGE_CHANNELS: 1 << 8,
  MANAGE_ROLES: 1 << 9,
  CREATE_INVITES: 1 << 10,
  KICK_MEMBERS: 1 << 11,
  BAN_MEMBERS: 1 << 12,
  MANAGE_GUILD: 1 << 13,
  /** Camera in voice channels (allowed for guests by default, unlike screen sharing). */
  VIDEO: 1 << 14,
  ADMINISTRATOR: 1 << 30,
} as const;

export type PermissionName = keyof typeof P;

export const ALL_PERMISSIONS = Object.values(P).reduce((a, b) => a | b, 0);

export const DEFAULT_ROLE_PERMS = {
  /** Applied to every member (the "@everyone" role). */
  member:
    P.VIEW_CHANNELS | P.SEND_MESSAGES | P.ATTACH_FILES | P.CONNECT_VOICE | P.SPEAK | P.STREAM |
    P.REQUEST_REMOTE_CONTROL | P.CREATE_INVITES | P.VIDEO,
  admin: P.ADMINISTRATOR,
  /** Browser guests (Faz 3): no remote control, no screen sharing, no management — enforced server side. Camera is allowed. */
  guest: P.VIEW_CHANNELS | P.SEND_MESSAGES | P.CONNECT_VOICE | P.SPEAK | P.VIDEO,
} as const;

/** Bits a guest can never hold, whatever their roles say. */
export const GUEST_FORBIDDEN = P.REQUEST_REMOTE_CONTROL | P.ADMINISTRATOR;

export function has(perms: number, bit: number): boolean {
  if ((perms & P.ADMINISTRATOR) !== 0) return true;
  return (perms & bit) === bit;
}
