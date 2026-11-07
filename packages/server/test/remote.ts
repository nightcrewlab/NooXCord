// Remote-control rules on the host (CLAUDE.md §7.3): request/grant/input/stop; viewers by role (browsers too),
// only desktop streamers controllable; tunnel-mode browser screen share.
// Run: pnpm --filter @nooxcord/server test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { P, type AuthResponse, type Events, type GuildState, type MethodName, type VoiceJoinResult, type VoiceState } from "@nooxcord/shared";
import { startHost } from "../src/index";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-remote-"));
const host = await startHost({ dataDir, port: 0 });
const base = `http://127.0.0.1:${host.port}`;
let passed = 0;
const ok = (m: string) => { passed++; console.log("  ✓", m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(p: string, body: unknown): Promise<T> {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as T;
}

class Client {
  ws!: WebSocket;
  events: { e: string; d: unknown }[] = [];
  id = "";
  private seq = 0;
  private pending = new Map<number, (f: { ok: boolean; d?: unknown; e?: { code: string; msg: string } }) => void>();
  constructor(private token: string, private client: "desktop" | "web") {}
  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(base.replace("http", "ws") + "/ws");
      this.ws.on("open", () => this.ws.send(JSON.stringify({ t: "auth", d: { token: this.token, client: this.client } })));
      this.ws.on("message", (raw) => {
        const f = JSON.parse(String(raw));
        if (f.t === "res") this.pending.get(f.id)?.(f);
        if (f.t === "evt") {
          this.events.push({ e: f.e, d: f.d });
          if (f.e === "ready") { this.id = (f.d as Events["ready"]).user.id; resolve(); }
        }
      });
    });
  }
  call<T = unknown>(m: MethodName, d: unknown): Promise<T> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ t: "req", id, m, d }));
    return new Promise((res, rej) => this.pending.set(id, (f) => (f.ok ? res(f.d as T) : rej(Object.assign(new Error(f.e?.msg), { code: f.e?.code })))));
  }
  rc(to: string, ev: unknown[]) { this.ws.send(JSON.stringify({ t: "rc", to, ev })); }
  count(e: string) { return this.events.filter((x) => x.e === e).length; }
  async waitFor<T>(e: string, pred: (d: T) => boolean = () => true, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.events.find((x) => x.e === e && pred(x.d as T));
      if (hit) return hit.d as T;
      await sleep(20);
    }
    throw new Error(`timeout waiting for ${e}`);
  }
}

const rejects = async (p: Promise<unknown>, code: string) => {
  try { await p; } catch (e) { assert.equal((e as { code?: string }).code, code); return; }
  assert.fail(`expected ${code}`);
};

try {
  const reg = (n: string) => post<AuthResponse>("/api/auth/register", { nickname: n, email: `${n}@t.local`, password: "testtest123" });
  const [ra, rb, rw] = await Promise.all([reg("Yayinci"), reg("Izleyici"), reg("Tarayici")]);
  const rg = await post<AuthResponse>("/api/auth/guest", { nickname: "Misafir" });
  const A = new Client(ra.token, "desktop"), B = new Client(rb.token, "desktop"), W = new Client(rw.token, "web"), G = new Client(rg.token, "web");
  await Promise.all([A, B, W, G].map((c) => c.connect()));

  const gs = await A.call<GuildState>("guild.create", { name: "RC" });
  const vc = gs.channels.find((c) => c.kind === "voice")!.id;
  const inv = await A.call<{ code: string }>("invite.create", { guildId: gs.guild.id });
  for (const c of [B, W, G]) await c.call("invite.join", { code: inv.code });
  const joined = await A.call<VoiceJoinResult>("voice.join", { channelId: vc });
  for (const c of [B, W, G]) await c.call("voice.join", { channelId: vc, transport: "ws" });

  // A streams (a VP8 screen producer is enough for the host).
  await A.call("media.produce", {
    transportId: joined.send!.id, kind: "video", source: "screen",
    rtpParameters: { codecs: [{ mimeType: "video/VP8", payloadType: 101, clockRate: 90000 }], encodings: [{ ssrc: 22222 }] },
  });
  const live = await A.call<VoiceState>("stream.start", { width: 1280, height: 720, fps: 30, audio: false });
  assert.equal(live.stream?.controllable, true);
  for (const c of [B, W, G]) await c.call("stream.watch", { userId: A.id, watching: true });
  ok("streamer live (controllable), three viewers");

  await rejects(B.call("remote.request", { userId: B.id }), "not_found");
  await rejects(A.call("remote.request", { userId: A.id }), "bad_request");
  await rejects(G.call("remote.request", { userId: A.id }), "forbidden");
  await rejects(A.call("remote.respond", { userId: G.id, allow: true }), "forbidden");
  ok("a guest without a role granting it can neither ask for nor be given control");

  // A browser viewer with the permission (registered member) may ask; the streamer sees it.
  await W.call("remote.request", { userId: A.id });
  await A.waitFor<Events["remote.request"]>("remote.request", (d) => d.userId === W.id);
  // The host gives the guest an explicit role with the bit: now they may ask too.
  const role = await A.call<{ id: string }>("role.create", { guildId: gs.guild.id, name: "Kontrol", perms: P.REQUEST_REMOTE_CONTROL });
  await A.call("member.setRoles", { guildId: gs.guild.id, userId: G.id, roleIds: [role.id] });
  await G.waitFor<{ myPerms: number }>("perms.update", (d) => (d.myPerms & P.REQUEST_REMOTE_CONTROL) !== 0);
  await G.call("remote.request", { userId: A.id });
  await A.waitFor<Events["remote.request"]>("remote.request", (d) => d.userId === G.id);
  ok("browser viewers and guests may ask when a role grants it");

  await B.call("remote.request", { userId: A.id });
  await A.waitFor<Events["remote.request"]>("remote.request", (d) => d.userId === B.id);
  await rejects(B.call("remote.request", { userId: A.id }), "rate_limited");
  ok("request reaches the streamer (and is rate limited)");

  // Input before grant is dropped.
  B.rc(A.id, [{ k: "m", x: 0.5, y: 0.5 }]);
  await sleep(150);
  assert.equal(A.count("remote.input"), 0);

  await A.call("remote.respond", { userId: B.id, allow: true });
  await B.waitFor<Events["remote.answer"]>("remote.answer", (d) => d.allow);
  const st = await W.waitFor<VoiceState>("voice.state", (v) => v.userId === A.id && v.stream?.controllerId === B.id);
  assert.equal(st.stream!.controllerId, B.id);
  ok("grant: everyone sees who controls the stream");

  B.rc(A.id, [{ k: "m", x: 0.25, y: 0.75 }, { k: "b", b: 0, d: true }, { k: "b", b: 0, d: false }, { k: "k", c: "KeyA", d: true }]);
  const inp = await A.waitFor<Events["remote.input"]>("remote.input");
  assert.equal(inp.from, B.id);
  assert.equal(inp.ev.length, 4);
  // Bad frames and non-controllers are ignored.
  B.rc(A.id, [{ k: "m", x: 2, y: 0 }]);
  B.rc(A.id, [{ k: "k", c: "<script>", d: true }]);
  W.rc(A.id, [{ k: "m", x: 0.1, y: 0.1 }]);
  await sleep(200);
  assert.equal(A.count("remote.input"), 1);
  ok("controller input forwarded; invalid frames and other viewers dropped");

  await rejects(W.call("remote.stop", { streamerId: A.id }), "forbidden");
  await B.call("remote.stop", { streamerId: A.id });
  await W.waitFor<VoiceState>("voice.state", (v) => v.userId === A.id && !!v.stream && v.stream.controllerId === null);
  ok("controller can release; others cannot stop it");

  await A.call("remote.respond", { userId: B.id, allow: true });
  await W.waitFor<VoiceState>("voice.state", (v) => v.userId === A.id && v.stream?.controllerId === B.id && W.count("voice.state") > 0);
  await A.call("remote.stop", { streamerId: A.id });
  await sleep(100);
  await A.call("remote.respond", { userId: B.id, allow: true });
  await B.call("stream.watch", { userId: A.id, watching: false });
  const last = () => (W.events.filter((x) => x.e === "voice.state" && (x.d as VoiceState).userId === A.id).at(-1)!.d as VoiceState);
  await sleep(150);
  assert.equal(last().stream?.controllerId, null);
  ok("streamer revokes; stopping watching ends control");

  await B.call("stream.watch", { userId: A.id, watching: true });
  await A.call("remote.respond", { userId: B.id, allow: true });
  await A.call("stream.stop", {});
  await sleep(150);
  assert.equal(last().stream, null);
  B.rc(A.id, [{ k: "m", x: 0.5, y: 0.5 }]);
  await sleep(150);
  assert.equal(A.count("remote.input"), 1);
  ok("stream stop ends control; later input is dropped");

  // --- tunnel-mode browser screen share: works, but cannot be controlled ---
  const role2 = await A.call<{ id: string }>("role.create", { guildId: gs.guild.id, name: "Yayin", perms: P.STREAM });
  await A.call("member.setRoles", { guildId: gs.guild.id, userId: G.id, roleIds: [role.id, role2.id] });
  await G.waitFor<{ myPerms: number }>("perms.update", (d) => (d.myPerms & P.STREAM) !== 0);
  // Stream audio rides the tunnel too (stereo Opus); kind must match the source.
  await rejects(G.call("media.produce", { transportId: "ws", kind: "video", rtpParameters: {}, source: "screen-audio" }), "bad_request");
  await G.call("media.produce", { transportId: "ws", kind: "audio", rtpParameters: {}, source: "screen-audio" });
  await G.call("media.produce", { transportId: "ws", kind: "video", rtpParameters: {}, source: "screen" });
  const gl = await G.call<VoiceState>("stream.start", { width: 1280, height: 720, fps: 15, audio: true });
  assert.equal(gl.stream?.controllable, false);
  await B.call("stream.watch", { userId: G.id, watching: true });
  await rejects(B.call("remote.request", { userId: G.id }), "forbidden");
  await G.call("stream.stop", {});
  ok("tunnel-mode browser can screen share; browser streams are not controllable");

  // --- direct messages ---
  const dm = await A.call<{ id: string; userIds: string[] }>("dm.open", { userId: B.id });
  assert.deepEqual([...dm.userIds].sort(), [A.id, B.id].sort());
  await B.waitFor<Events["dm.create"]>("dm.create", (d) => d.dm.id === dm.id);
  const again = await B.call<{ id: string }>("dm.open", { userId: A.id });
  assert.equal(again.id, dm.id);
  ok("dm.open creates one conversation per pair, both sides notified");

  await A.call("message.send", { channelId: dm.id, content: "selam" });
  await B.waitFor<{ channelId: string; content: string }>("message.create", (m) => m.channelId === dm.id && m.content === "selam");
  await sleep(100);
  assert.ok(!W.events.some((x) => x.e === "message.create" && (x.d as { channelId: string }).channelId === dm.id));
  await rejects(W.call("message.list", { channelId: dm.id }), "not_found");
  await rejects(W.call("message.send", { channelId: dm.id, content: "x" }), "not_found");
  assert.equal((await B.call<unknown[]>("message.list", { channelId: dm.id })).length, 1);
  ok("DM messages reach only the two members");

  await rejects(A.call("dm.open", { userId: A.id }), "bad_request");
  const rx = await reg("Yabanci");
  await rejects(A.call("dm.open", { userId: (await (async () => { const X = new Client(rx.token, "desktop"); await X.connect(); X.ws.close(); return X.id; })()) }), "forbidden");
  const gdm = await G.call<{ id: string }>("dm.open", { userId: A.id });
  assert.ok(gdm.id);
  await rejects(A.call("channel.delete", { channelId: dm.id }), "not_found");
  ok("no DMs to self or strangers; guests can DM co-members; DMs are not guild channels");

  const R = new Client(ra.token, "desktop");
  await R.connect();
  const ready = R.events.find((x) => x.e === "ready")!.d as Events["ready"];
  assert.equal(ready.dms.length, 2);
  assert.ok(ready.users.some((u) => u.id === G.id));
  R.ws.close();
  ok("ready payload lists DMs and their users");

  for (const c of [A, B, W, G]) c.ws.close();
  await host.close();
  console.log(`\nREMOTE PASS (${passed} checks)`);
} catch (e) {
  console.error("\nREMOTE FAIL:", e);
  await host.close().catch(() => {});
  process.exitCode = 1;
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
