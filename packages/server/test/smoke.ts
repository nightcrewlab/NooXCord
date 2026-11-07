// End-to-end smoke test for the host: two users, guild, invite, realtime messages, uploads, perms.
// Run: pnpm --filter @nooxcord/server test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { AuthResponse, Events, GuildState, Message, MethodName } from "@nooxcord/shared";
import { P } from "@nooxcord/shared";
import { startHost } from "../src/index";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-smoke-"));
const host = await startHost({ dataDir, port: 0 });
const base = `http://127.0.0.1:${host.port}`;
let passed = 0;
const ok = (m: string) => { passed++; console.log("  ✓", m); };

async function post<T>(p: string, body: unknown, token?: string): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as T };
}

class Client {
  ws!: WebSocket;
  events: { e: string; d: unknown }[] = [];
  private id = 0;
  private pending = new Map<number, (f: { ok: boolean; d?: unknown; e?: { msg: string } }) => void>();
  constructor(public token: string) {}
  connect(): Promise<Events["ready"]> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(base.replace("http", "ws") + "/ws");
      this.ws.on("open", () => this.ws.send(JSON.stringify({ t: "auth", d: { token: this.token } })));
      this.ws.on("close", (c) => reject(new Error("closed " + c)));
      this.ws.on("message", (raw) => {
        const f = JSON.parse(String(raw));
        if (f.t === "res") this.pending.get(f.id)?.(f);
        if (f.t === "evt") {
          this.events.push({ e: f.e, d: f.d });
          if (f.e === "ready") resolve(f.d);
        }
      });
    });
  }
  call<T>(m: MethodName, d: unknown): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ t: "req", id, m, d }));
    return new Promise((res, rej) => this.pending.set(id, (f) => (f.ok ? res(f.d as T) : rej(new Error(f.e?.msg)))));
  }
  async waitFor<T>(e: string, pred: (d: T) => boolean = () => true, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.events.find((x) => x.e === e && pred(x.d as T));
      if (hit) return hit.d as T;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${e}`);
  }
}

try {
  // --- auth ---
  const a = await post<AuthResponse>("/api/auth/register", { nickname: "NooXRii", email: "noox@example.test", password: "correct-horse" });
  assert.equal(a.status, 200);
  const b = await post<AuthResponse>("/api/auth/register", { nickname: "Ayşe", email: "ayse@example.test", password: "battery-staple" });
  assert.equal(b.status, 200);
  ok("register two users");
  assert.equal((await post("/api/auth/register", { nickname: "nooxrii", email: "x@example.test", password: "12345678" })).status, 409);
  ok("nickname uniqueness is case-insensitive");
  assert.equal((await post("/api/auth/login", { login: "noox@example.test", password: "wrong-pass" })).status, 401);
  const relog = await post<AuthResponse>("/api/auth/login", { login: "NooXRii", password: "correct-horse" });
  assert.equal(relog.status, 200);
  ok("login by nickname, wrong password rejected");

  // --- realtime ---
  const A = new Client(a.body.token), B = new Client(b.body.token);
  const readyA = await A.connect();
  await B.connect();
  assert.equal(readyA.user.nickname, "NooXRii");
  ok("websocket auth + ready");

  const gs = await A.call<GuildState>("guild.create", { name: "NooX Lab" });
  assert.equal(gs.channels.length, 2);
  const text = gs.channels.find((c) => c.kind === "text")!;
  ok("guild.create with default channels");

  await assert.rejects(B.call("message.send", { channelId: text.id, content: "hi" }), /Kanal bulunamadı|Sunucu bulunamadı/);
  ok("non-member cannot post");

  const inv = await A.call<{ code: string }>("invite.create", { guildId: gs.guild.id, maxUses: 5 });
  const joined = await B.call<GuildState>("invite.join", { code: inv.code });
  assert.equal(joined.guild.id, gs.guild.id);
  assert.ok(!(joined.myPerms & P.MANAGE_CHANNELS));
  await A.waitFor("member.add");
  ok("invite join + member.add event, member lacks manage perms");

  const msg = await B.call<Message>("message.send", { channelId: text.id, content: "Merhaba https://example.invalid", nonce: "n1" });
  const seen = await A.waitFor<Message>("message.create", (m) => m.id === msg.id);
  assert.equal(seen.content, "Merhaba https://example.invalid");
  ok("message delivered realtime to other member");

  await assert.rejects(A.call("message.edit", { messageId: msg.id, content: "hack" }), /kendi mesajını/);
  await B.call("message.edit", { messageId: msg.id, content: "Merhaba (düzenlendi)" });
  await A.waitFor<Message>("message.update", (m) => m.id === msg.id && m.editedAt !== null);
  ok("only author can edit; edit broadcast");

  await assert.rejects(B.call("channel.create", { guildId: gs.guild.id, name: "gizli", kind: "text" }), /yetkin yok/);
  ok("member cannot create channels");

  // --- upload ---
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
  const fd = new FormData();
  fd.append("width", "1");
  fd.append("height", "1");
  fd.append("file", new Blob([png], { type: "text/html" }), "dot.png");
  const up = await fetch(base + "/api/uploads", { method: "POST", headers: { authorization: `Bearer ${b.body.token}` }, body: fd });
  const att = (await up.json()) as { id: string; mime: string; url: string };
  assert.equal(att.mime, "image/png");
  ok("upload sniffs real type (ignores declared text/html)");
  assert.equal((await fetch(base + att.url)).status, 404);
  const withFile = await B.call<Message>("message.send", { channelId: text.id, content: "", attachmentIds: [att.id] });
  const fileRes = await fetch(base + withFile.attachments[0]!.url);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get("content-type"), "image/png");
  await assert.rejects(B.call("message.send", { channelId: text.id, content: "x", attachmentIds: [att.id] }), /zaten kullanılmış/);
  ok("attachment served only after claim; cannot reuse");

  const html = new FormData();
  html.append("file", new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "x.html");
  const hUp = (await (await fetch(base + "/api/uploads", { method: "POST", headers: { authorization: `Bearer ${b.body.token}` }, body: html })).json()) as { id: string };
  const hMsg = await B.call<Message>("message.send", { channelId: text.id, content: "", attachmentIds: [hUp.id] });
  const hRes = await fetch(base + hMsg.attachments[0]!.url);
  assert.equal(hRes.headers.get("content-type"), "application/octet-stream");
  assert.match(hRes.headers.get("content-disposition") ?? "", /^attachment/);
  ok("HTML upload is served as download, never inline");

  // --- history & roles ---
  const hist = await A.call<Message[]>("message.list", { channelId: text.id });
  assert.equal(hist.length, 3);
  ok("message.list returns history");

  const admin = gs.roles.find((r) => r.name === "Yönetici")!;
  await A.call("member.setRoles", { guildId: gs.guild.id, userId: b.body.user.id, roleIds: [admin.id] });
  const pu = await B.waitFor<{ myPerms: number }>("perms.update");
  assert.ok(pu.myPerms & P.ADMINISTRATOR);
  await B.call("channel.create", { guildId: gs.guild.id, name: "Yeni Kanal", kind: "text" });
  const created = await A.waitFor<{ name: string }>("channel.create");
  assert.equal(created.name, "yeni-kanal");
  ok("role grant -> perms.update -> can create channel (name normalised)");

  await assert.rejects(B.call("member.kick", { guildId: gs.guild.id, userId: a.body.user.id }), /sahibi/);
  ok("owner cannot be kicked");

  await A.call("member.kick", { guildId: gs.guild.id, userId: b.body.user.id });
  await B.waitFor("guild.remove");
  ok("kick removes member and notifies them");

  B.ws.close();
  await A.waitFor<{ id: string; online: boolean }>("user.update", (u) => u.id === b.body.user.id && !u.online).catch(() => {
    // B is no longer in a shared guild after the kick, so no presence event is expected.
  });

  // --- persistence ---
  A.ws.close();
  await host.close();
  const host2 = await startHost({ dataDir, port: 0 });
  const C = new Client(a.body.token);
  const base2 = `ws://127.0.0.1:${host2.port}/ws`;
  C.ws = new WebSocket(base2);
  const ready2 = await new Promise<Events["ready"]>((res) => {
    C.ws.on("open", () => C.ws.send(JSON.stringify({ t: "auth", d: { token: a.body.token } })));
    C.ws.on("message", (raw) => { const f = JSON.parse(String(raw)); if (f.e === "ready") res(f.d); });
  });
  assert.equal(ready2.guilds.length, 1);
  ok("session token survives host restart (no re-login)");
  C.ws.close();
  await host2.close();

  console.log(`\nSMOKE PASS (${passed} checks)`);
} catch (e) {
  console.error("\nSMOKE FAIL:", e);
  await host.close().catch(() => {});
  process.exitCode = 1;
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
