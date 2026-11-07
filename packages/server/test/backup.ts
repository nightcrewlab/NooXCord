// Host database backups: daily snapshot at start, manual snapshot while running, restore into a new host.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@nooxcord/shared";
import { isHostDb, listBackups, prune, restoreInto } from "../src/backup";
import { startHost } from "../src/index";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-backup-"));
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "nx-backup2-"));
let passed = 0;
const ok = (m: string) => { passed++; console.log("  ✓", m); };
try {
  const host = await startHost({ dataDir: dir, port: 0 });
  const backups = path.join(dir, "backups");
  assert.equal(listBackups(backups).length, 1, "daily backup at start");
  ok("first start makes the daily backup");

  const r = await fetch(`http://127.0.0.1:${host.port}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "Yedek", email: "y@t.local", password: "testtest123" }),
  }).then((x) => x.json() as Promise<AuthResponse>);
  assert.ok(r.token);
  const b = host.backup("manual");
  assert.ok(b.name.endsWith("-manual.db") && isHostDb(path.join(backups, b.name)));
  assert.ok(!isHostDb(path.join(dir, "proxy.key")));
  ok("snapshot while running is a valid host database; other files are refused");

  for (let i = 0; i < 9; i++) host.backup("x");
  prune(backups);
  assert.equal(listBackups(backups).length, 7);
  ok("only the newest 7 backups are kept");
  await host.close();

  restoreInto(path.join(dir2, "nooxcord.db"), path.join(backups, listBackups(backups)[0]!.name));
  const host2 = await startHost({ dataDir: dir2, port: 0 });
  const login = await fetch(`http://127.0.0.1:${host2.port}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "Yedek", password: "testtest123" }),
  });
  assert.equal(login.status, 200);
  await host2.close();
  ok("restored database starts and keeps accounts");
  console.log(`\nBACKUP PASS (${passed} checks)`);
} catch (e) {
  console.error("\nBACKUP FAIL:", e);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
}
