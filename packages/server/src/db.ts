import fs from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Client } from "@libsql/client";
import { Mirror, orphanDeletes, pullFromRemote, pushToRemote, toInValue, type Stmt } from "./mirror";

/**
 * SQLite through Node's built-in `node:sqlite` (no native addon to rebuild for Electron).
 * Schema changes are append-only numbered migrations.
 */
const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT COLLATE NOCASE UNIQUE,
    pass_hash TEXT,
    avatar TEXT,
    status TEXT NOT NULL DEFAULT 'online',
    guest INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE guilds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','voice')),
    topic TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX channels_guild ON channels(guild_id);
  CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    perms INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX roles_guild ON roles(guild_id);
  CREATE TABLE members (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX members_user ON members(user_id);
  CREATE TABLE member_roles (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
  );
  CREATE TABLE bans (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    reply_to TEXT,
    embeds TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    edited_at INTEGER
  );
  CREATE INDEX messages_channel ON messages(channel_id, id);
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id),
    uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE read_states (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  /* 2: direct messages. Channels may have no guild (kind 'dm'); rebuilt per SQLite's ALTER TABLE recipe. */ `
  CREATE TABLE channels_new (
    id TEXT PRIMARY KEY,
    guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','voice','dm')),
    topic TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  INSERT INTO channels_new (id, guild_id, name, kind, topic, position, created_at)
    SELECT id, guild_id, name, kind, topic, position, created_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;
  CREATE INDEX channels_guild ON channels(guild_id);
  CREATE TABLE dm_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX dm_members_user ON dm_members(user_id);
  `,
  /* 3 — camera permission (VIDEO = 1 << 14) for everyone's default role */ `
  UPDATE roles SET perms = perms | 16384 WHERE is_default = 1;
  `,
  /* 4 — uploaded files live in the database (Render's disk is not kept, ADR 0003), in parts of at most
     512 KB so every mirrored write to Turso stays small. */ `
  CREATE TABLE blobs (
    id TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE blob_parts (
    blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (blob_id, idx)
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Schema version of an existing database file (0 when missing/unreadable). */
export function fileVersion(file: string): number {
  try {
    const d = new DatabaseSync(file, { readOnly: true });
    try { return Number((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version); } finally { d.close(); }
  } catch {
    return 0;
  }
}

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  /** Turso copy (ADR 0003); null = local file only (development, tests). */
  private mirror: Mirror | null = null;
  /** Writes of the running transaction, sent to the mirror on COMMIT. */
  private txWrites: Stmt[] | null = null;

  constructor(file: string, opts: { migrate?: boolean } = {}) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    if (opts.migrate !== false) this.migrate();
  }

  /**
   * Database backed by Turso: the local file is rebuilt from Turso, migrated, and from then on every
   * write is mirrored there. A fresh Turso database (or a migration) gets the whole database at once.
   */
  static async open(file: string, client: Client, log: (...a: unknown[]) => void): Promise<Db> {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    const db = new Db(file, { migrate: false });
    try {
      const remote = await pullFromRemote(client, db.raw, log);
      const applied = db.migrate();
      if (!remote || applied) await pushToRemote(client, db.raw, SCHEMA_VERSION, log);
      db.mirror = new Mirror(client, log);
      const orphans = orphanDeletes(db.raw);
      if (orphans.length) {
        log(`[db] removing ${orphans.length} rows whose parent row is gone`);
        db.tx(() => { for (const o of orphans) db.run(o.sql, ...(o.args as SQLInputValue[])); });
      }
    } catch (e) {
      db.close();
      throw e;
    }
    return db;
  }

  /** Applies pending migrations; returns how many ran. */
  private migrate(): number {
    const version = Number((this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version >= MIGRATIONS.length) return 0;
    // Table rebuilds must not cascade: foreign keys are off while migrating, then verified.
    this.raw.exec("PRAGMA foreign_keys = OFF");
    try {
      for (let v = version; v < MIGRATIONS.length; v++) {
        this.tx(() => {
          this.raw.exec(MIGRATIONS[v]!);
          const bad = this.raw.prepare("PRAGMA foreign_key_check").all();
          if (bad.length) throw new Error(`migration ${v + 1}: foreign key check failed`);
          this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        });
      }
    } finally {
      this.raw.exec("PRAGMA foreign_keys = ON");
    }
    return MIGRATIONS.length - version;
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /** Writes go through here (and only here) so the Turso mirror sees each one that changed something. */
  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const r = this.stmt(sql).run(...params);
    const changes = Number(r.changes);
    if (this.mirror && changes > 0) {
      const s: Stmt = { sql, args: params.map(toInValue) };
      if (this.txWrites) this.txWrites.push(s);
      else this.mirror.push([s]);
    }
    return { changes };
  }

  /** Runs fn in a transaction (nested calls join the outer one). */
  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec("BEGIN IMMEDIATE");
    this.txWrites = this.mirror ? [] : null;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      if (this.txWrites?.length) this.mirror!.push(this.txWrites);
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.txWrites = null;
      this.depth--;
    }
  }

  /** Writes still on their way to Turso. */
  get pendingMirror(): number {
    return this.mirror?.pending ?? 0;
  }

  /** Waits for queued Turso writes (shutdown). */
  async flush(timeoutMs = 10_000): Promise<boolean> {
    return this.mirror ? this.mirror.drain(timeoutMs) : true;
  }

  close(): void {
    this.raw.close();
  }
}
