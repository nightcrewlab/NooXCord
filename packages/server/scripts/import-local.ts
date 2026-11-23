/**
 * One-off move of a self-hosted NooXCord host (Faz 0–5, %APPDATA%/NooXCord/host) to Turso (ADR 0003):
 * copies the database, migrates it, puts avatars / server icons / uploads into the blobs table and the
 * old link-preview key into settings, then replaces everything on Turso with it.
 *
 *   pnpm --filter @nooxcord/server import:local [hostDir] [--dry]
 *
 * Needs TURSO_DATABASE_URL + TURSO_AUTH_TOKEN unless --dry. Restart the server afterwards: it rebuilds
 * its working copy from Turso on start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db, SCHEMA_VERSION } from "../src/db";
import { pushToRemote } from "../src/mirror";

const PART = 512 * 1024;
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const src = args.find((a) => !a.startsWith("--")) ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), "NooXCord/host");
const log = (...a: unknown[]) => console.log(...a);

const oldDb = path.join(src, "nooxcord.db");
if (!fs.existsSync(oldDb)) throw new Error(`no database at ${oldDb}`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "nx-import-"));
const file = path.join(work, "nooxcord.db");
for (const ext of ["", "-wal", "-shm"]) if (fs.existsSync(oldDb + ext)) fs.copyFileSync(oldDb + ext, file + ext);

const db = new Db(file); // runs the migrations up to SCHEMA_VERSION
const count = (t: string) => (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0);

let files = 0;
let bytes = 0;
db.tx(() => {
  for (const dir of ["avatars", "guild-icons", "uploads"]) {
    const d = path.join(src, dir);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const id = dir === "uploads" ? name : name.replace(/\.[a-z0-9]+$/i, "");
      if (!/^[a-z0-9]+$/.test(id) || db.get("SELECT 1 FROM blobs WHERE id = ?", id)) continue;
      const data = fs.readFileSync(path.join(d, name));
      db.run("INSERT INTO blobs (id, size, created_at) VALUES (?, ?, ?)", id, data.byteLength, fs.statSync(path.join(d, name)).mtimeMs | 0);
      for (let i = 0, idx = 0; i < data.byteLength || idx === 0; i += PART, idx++) {
        db.run("INSERT INTO blob_parts (blob_id, idx, data) VALUES (?, ?, ?)", id, idx, data.subarray(i, i + PART));
      }
      files++;
      bytes += data.byteLength;
    }
  }
  const key = path.join(src, "proxy.key");
  if (fs.existsSync(key) && !db.get("SELECT 1 FROM settings WHERE key = 'proxy_key'")) {
    const raw = fs.readFileSync(key);
    if (raw.byteLength === 32) db.run("INSERT INTO settings (key, value) VALUES ('proxy_key', ?)", raw.toString("hex"));
  }
});

const missing = db.all<{ stored: string }>("SELECT stored FROM attachments WHERE stored NOT IN (SELECT id FROM blobs)");
log(`users ${count("users")}, guilds ${count("guilds")}, channels ${count("channels")}, messages ${count("messages")}, attachments ${count("attachments")}`);
log(`files ${files} (${(bytes / 1048576).toFixed(1)} MB)${missing.length ? `, ${missing.length} attachments without a file` : ""}`);

if (dry) {
  log(`dry run: migrated copy at ${file}`);
} else {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  const { createClient } = await import("@libsql/client/web");
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  await pushToRemote(client, db.raw, SCHEMA_VERSION, log);
  client.close();
  log("done: restart the server so it loads the imported data");
}
db.close();
