// Turso mirror (ADR 0003) against a real libSQL database (a local file stands in for Turso):
// fresh push, write-through, rebuild from the remote, cascades, files in the database, migrations.
// Run: pnpm --filter @nooxcord/server test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import WebSocket from "ws";
import type { AuthResponse, GuildState, Message, MethodName } from "@nooxcord/shared";
import { Db } from "../src/db";
import { startHost, type RunningHost } from "../src/index";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nx-mirror-"));
const remoteFile = path.join(tmp, "turso.db");
let passed = 0;
const ok = (m: string) => { passed++; console.log("  ✓", m); };
const remote = (): Client => createClient({ url: pathToFileURL(remoteFile).href });
const quiet = () => {};

async function boot(dir: string): Promise<{ host: RunningHost; base: string }> {
  const host = await startHost({ dataDir: path.join(tmp, dir), port: 0, remote: remote(), log: quiet });
  return { host, base: `http://127.0.0.1:${host.port}` };
}

async function rpc<T>(base: string, token: string, m: MethodName, d: unknown): Promise<T> {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  try {
    return await new Promise<T>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ t: "auth", d: { token } })));
      ws.on("message", (raw) => {
        const f = JSON.parse(String(raw));
        if (f.t === "evt" && f.e === "ready") ws.send(JSON.stringify({ t: "req", id: 1, m, d }));
        if (f.t === "res") (f.ok ? resolve(f.d as T) : reject(new Error(f.e.msg)));
      });
      ws.on("error", reject);
    });
  } finally {
    ws.close();
  }
}

const count = async (c: Client, sql: string): Promise<number> => Number((await c.execute(sql)).rows[0]![0]);

try {
  // 1. Fresh Turso: the whole schema goes up at start.
  let { host, base } = await boot("a");
  const r = remote();
  assert.equal(Number((await r.execute("SELECT value FROM _nx_meta WHERE key = 'schema_version'")).rows[0]![0]), 4);
  assert.ok((await count(r, "SELECT count(*) FROM sqlite_master WHERE name LIKE '_nxfk_%'")) > 5);
  ok("empty Turso gets schema, version and cascade triggers");

  // 2. Writes reach Turso (single statements and transactions).
  const reg = await (await fetch(base + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: "Ayna", email: "ayna@t.local", password: "testtest123" }) })).json() as AuthResponse;
  const gs = await rpc<GuildState>(base, reg.token, "guild.create", { name: "Yansima" });
  const text = gs.channels.find((c) => c.kind === "text")!.id;
  const bytes = Buffer.alloc(1_300_000, 7); // 3 parts of 512 KB
  bytes.write("hello", 0);
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), "big.bin");
  const att = await (await fetch(base + "/api/uploads", { method: "POST", headers: { authorization: `Bearer ${reg.token}` }, body: fd })).json() as { id: string };
  const msg = await rpc<Message>(base, reg.token, "message.send", { channelId: text, content: "kalici mesaj", attachmentIds: [att.id] });
  await host.close(); // drains the mirror
  assert.equal(await count(r, "SELECT count(*) FROM users"), 1);
  assert.equal(await count(r, `SELECT count(*) FROM messages WHERE content = 'kalici mesaj'`), 1);
  assert.equal(await count(r, "SELECT count(*) FROM blob_parts"), 3);
  ok("writes and a 1.3 MB file (3 parts) reached Turso");

  // 3. A new host with an empty disk rebuilds everything from Turso.
  ({ host, base } = await boot("b"));
  const list = await rpc<Message[]>(base, reg.token, "message.list", { channelId: text });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.content, "kalici mesaj");
  const file = Buffer.from(await (await fetch(base + list[0]!.attachments[0]!.url)).arrayBuffer());
  assert.equal(file.length, bytes.length);
  assert.ok(file.equals(bytes));
  ok("a host on a fresh disk has the account, session, messages and the file back");

  // 4. Cascades: deleting the guild removes channels, messages, attachments, file parts on Turso too.
  await rpc(base, reg.token, "guild.delete", { guildId: gs.guild.id });
  await host.close();
  for (const t of ["guilds", "channels", "messages", "attachments", "blobs", "blob_parts", "members", "roles"]) {
    assert.equal(await count(r, `SELECT count(*) FROM ${t}`), 0, t);
  }
  assert.equal(await count(r, "SELECT count(*) FROM users"), 1);
  ok("guild delete cascades on Turso (channels, messages, files, members, roles)");
  void msg;

  // 5. A migration on an older Turso database re-uploads the whole database.
  const localFile = path.join(tmp, "c.db");
  const db = await Db.open(localFile, remote(), quiet);
  db.run("INSERT INTO settings (key, value) VALUES ('probe', '1')");
  await db.flush();
  db.close();
  await r.execute("UPDATE _nx_meta SET value = '3' WHERE key = 'schema_version'");
  await r.execute("DROP TABLE blob_parts");
  await r.execute("DROP TABLE blobs");
  const db2 = await Db.open(localFile, remote(), quiet);
  db2.close();
  assert.equal(Number((await r.execute("SELECT value FROM _nx_meta WHERE key = 'schema_version'")).rows[0]![0]), 4);
  assert.equal(await count(r, "SELECT count(*) FROM settings WHERE key = 'probe'"), 1);
  assert.equal(await count(r, "SELECT count(*) FROM sqlite_master WHERE name = 'blob_parts'"), 1);
  ok("migration on an older Turso schema: migrated locally, whole database written back");

  // 6. A foreign database is refused.
  const other = path.join(tmp, "other.db");
  const oc = createClient({ url: pathToFileURL(other).href });
  await oc.execute("CREATE TABLE x (a)");
  await assert.rejects(Db.open(path.join(tmp, "d.db"), oc, quiet), /no NooXCord schema version/);
  oc.close();
  ok("a Turso database that is not NooXCord's is refused");

  r.close();
  console.log(`\nMIRROR PASS (${passed} checks)`);
} catch (e) {
  console.error("\nMIRROR FAIL:", e);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a libSQL handle may still be open on Windows */ }
}
