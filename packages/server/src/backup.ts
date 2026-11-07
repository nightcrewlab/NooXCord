import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * Host database backups (CLAUDE.md §12.3): consistent snapshots with SQLite's VACUUM INTO (safe while
 * the host is running), one per day automatically, the newest KEEP kept. Uploads are not included:
 * they can be large and messages keep working without them.
 */

export const KEEP = 7;
const DAY = 24 * 60 * 60_000;
const NAME = /^nooxcord-(\d{8}-\d{6})(-[a-z0-9-]+)?\.db$/;

export interface BackupInfo { name: string; size: number; at: number }

const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

export function listBackups(dir: string): BackupInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => NAME.test(n))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { name: n, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

/** Snapshot of an open database (or a database file) into dir; returns the new backup. */
export function snapshot(source: DatabaseSync | string, dir: string, tag?: string): BackupInfo {
  fs.mkdirSync(dir, { recursive: true });
  const base = `nooxcord-${stamp()}${tag ? `-${tag}` : ""}`;
  let name = `${base}.db`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.db`;
  const file = path.join(dir, name);
  const db = typeof source === "string" ? new DatabaseSync(source, { readOnly: true }) : source;
  try {
    db.prepare("VACUUM INTO ?").run(file);
  } finally {
    if (typeof source === "string") db.close();
  }
  const st = fs.statSync(file);
  return { name, size: st.size, at: st.mtimeMs };
}

/** Deletes all but the newest `keep` backups. */
export function prune(dir: string, keep = KEEP): void {
  for (const b of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, b.name), { force: true });
}

/** Daily backup if the newest one is older than a day (or there is none). */
export function dailyBackup(db: DatabaseSync, dir: string): BackupInfo | null {
  const newest = listBackups(dir)[0];
  if (newest && Date.now() - newest.at < DAY) return null;
  const b = snapshot(db, dir);
  prune(dir);
  return b;
}

/** Is this file a NooXCord host database we can restore? */
export function isHostDb(file: string): boolean {
  try {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (head.toString("latin1") !== "SQLite format 3\0") return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
      const ok = ["users", "guilds", "channels", "messages", "sessions"].every((t) => tables.has(t));
      return ok && (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Replaces the host database with a backup (the host must be stopped). */
export function restoreInto(dbFile: string, backupFile: string): void {
  const tmp = dbFile + ".restore";
  fs.copyFileSync(backupFile, tmp);
  for (const ext of ["-wal", "-shm"]) fs.rmSync(dbFile + ext, { force: true });
  fs.renameSync(tmp, dbFile);
}
