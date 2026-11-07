import { z } from "zod";
import { LIMITS } from "./protocol";

/* Validation schemas. Server-only import path ("@nooxcord/shared/schemas") so clients don't bundle zod. */

const id = z.string().min(1).max(64);
export const nickname = z
  .string()
  .trim()
  .min(LIMITS.nicknameMin)
  .max(LIMITS.nicknameMax)
  .regex(/^[\p{L}\p{N}_.\- ]+$/u, "Yalnızca harf, rakam, boşluk, _ . -");
const channelName = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.channelNameMax)
  .transform((s) => s.toLocaleLowerCase("tr").replace(/\s+/g, "-"));
/** Opaque JSON object (mediasoup parameters); size is capped by the socket's max payload. */
const json = z.record(z.string(), z.unknown());
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable();

// ---------- HTTP (auth) ----------
export const RegisterBody = z.object({
  nickname,
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(LIMITS.passwordMin).max(256),
});
export const LoginBody = z.object({
  login: z.string().trim().min(1).max(254), // email or nickname
  password: z.string().min(1).max(256),
});

export const GuestBody = z.object({
  nickname,
  password: z.string().max(256).optional(),
});

// ---------- RPC methods ----------
export const Methods = {
  "me.update": z.object({ nickname: nickname.optional(), status: z.enum(["online", "idle", "dnd", "invisible"]).optional() }),
  "guild.create": z.object({ name: z.string().trim().min(1).max(LIMITS.guildNameMax) }),
  "guild.update": z.object({ guildId: id, name: z.string().trim().min(1).max(LIMITS.guildNameMax).optional() }),
  "guild.delete": z.object({ guildId: id }),
  "guild.leave": z.object({ guildId: id }),
  "channel.create": z.object({ guildId: id, name: channelName, kind: z.enum(["text", "voice"]) }),
  "channel.update": z.object({ channelId: id, name: channelName.optional(), topic: z.string().max(LIMITS.topicMax).optional() }),
  "channel.delete": z.object({ channelId: id }),
  "message.list": z.object({ channelId: id, before: id.optional(), limit: z.number().int().min(1).max(100).optional() }),
  "message.send": z.object({
    channelId: id,
    content: z.string().max(LIMITS.messageMax),
    replyTo: id.optional(),
    attachmentIds: z.array(id).max(LIMITS.attachmentsPerMessage).optional(),
    nonce: z.string().max(64).optional(),
  }),
  "message.edit": z.object({ messageId: id, content: z.string().min(1).max(LIMITS.messageMax) }),
  "message.delete": z.object({ messageId: id }),
  typing: z.object({ channelId: id }),
  "read.mark": z.object({ channelId: id, messageId: id }),
  "invite.create": z.object({ guildId: id, maxUses: z.number().int().min(1).max(1000).nullable().optional(), expiresInHours: z.number().min(1).max(24 * 30).nullable().optional() }),
  "invite.join": z.object({ code: z.string().trim().min(4).max(32) }),
  "dm.open": z.object({ userId: id }),
  "role.create": z.object({ guildId: id, name: z.string().trim().min(1).max(32), color: color.optional(), perms: z.number().int().nonnegative().optional() }),
  "role.update": z.object({ roleId: id, name: z.string().trim().min(1).max(32).optional(), color: color.optional(), perms: z.number().int().nonnegative().optional() }),
  "role.delete": z.object({ roleId: id }),
  "member.setRoles": z.object({ guildId: id, userId: id, roleIds: z.array(id).max(50) }),
  "member.kick": z.object({ guildId: id, userId: id }),
  "voice.join": z.object({ channelId: id, muted: z.boolean().optional(), deafened: z.boolean().optional(), transport: z.enum(["rtc", "ws"]).optional() }),
  "voice.leave": z.object({}),
  "voice.speaking": z.object({ speaking: z.boolean() }),
  "voice.update": z.object({ muted: z.boolean().optional(), deafened: z.boolean().optional() }),
  "media.connect": z.object({ transportId: id, dtlsParameters: json }),
  "media.produce": z.object({ transportId: id, kind: z.enum(["audio", "video"]), rtpParameters: json, source: z.enum(["mic", "screen", "screen-audio"]) }),
  "media.pauseProducer": z.object({ producerId: id, paused: z.boolean() }),
  "media.closeProducer": z.object({ producerId: id }),
  "media.consume": z.object({ producerId: id, rtpCapabilities: json }),
  "media.resume": z.object({ consumerId: id }),
  "media.closeConsumer": z.object({ consumerId: id }),
  "media.layers": z.object({ consumerId: id, spatial: z.number().int().min(0).max(2) }),
  "stream.start": z.object({ width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), fps: z.number().int().min(1).max(240), audio: z.boolean() }),
  "stream.stop": z.object({}),
  "stream.watch": z.object({ userId: id, watching: z.boolean() }),
  "member.ban": z.object({ guildId: id, userId: id }),
  "remote.request": z.object({ userId: id }),
  "remote.respond": z.object({ userId: id, allow: z.boolean() }),
  "remote.stop": z.object({ streamerId: id }),
} as const;

const unit = z.number().min(0).max(1);
export const RemoteInput = z.object({
  to: id,
  ev: z.array(z.discriminatedUnion("k", [
    z.object({ k: z.literal("m"), x: unit, y: unit }),
    z.object({ k: z.literal("b"), b: z.number().int().min(0).max(4), d: z.boolean() }),
    z.object({ k: z.literal("w"), dx: z.number().int().min(-2400).max(2400), dy: z.number().int().min(-2400).max(2400) }),
    z.object({ k: z.literal("k"), c: z.string().regex(/^[A-Za-z0-9]{1,24}$/), d: z.boolean() }),
  ])).min(1).max(LIMITS.remoteBatch),
});

