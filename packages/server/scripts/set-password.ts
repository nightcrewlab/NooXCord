/**
 * Sets a new password for a registered account directly on Turso (there is no e-mail reset yet).
 *
 *   pnpm --filter @nooxcord/server set-password <nickname or e-mail>
 *
 * Needs TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. The password is typed without echo. Restart the server
 * afterwards: it checks logins against its working copy, which it rebuilds from Turso on start.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { hashPassword } from "../src/auth";

const who = process.argv[2];
if (!who) throw new Error("usage: set-password <nickname or e-mail>");
const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("TURSO_DATABASE_URL is not set");

let muted = false;
const out = new Writable({ write: (chunk, _enc, cb) => { if (!muted) process.stdout.write(chunk); cb(); } });
const rl = createInterface({ input: process.stdin, output: out, terminal: true });
const ask = (q: string) => new Promise<string>((res) => {
  process.stdout.write(q);
  muted = true;
  rl.question("", (a) => { muted = false; process.stdout.write("\n"); res(a); });
});

const pw = await ask("New password: ");
const again = await ask("Again: ");
rl.close();
if (pw !== again) throw new Error("passwords do not match");
if (pw.length < 8) throw new Error("at least 8 characters");

const { createClient } = await import("@libsql/client/web");
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const rs = await client.execute({
  sql: "UPDATE users SET pass_hash = ? WHERE guest = 0 AND (nickname = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)",
  args: [await hashPassword(pw), who, who],
});
client.close();
console.log(rs.rowsAffected ? `password changed for ${who}: restart the server` : `no registered account named ${who}`);
