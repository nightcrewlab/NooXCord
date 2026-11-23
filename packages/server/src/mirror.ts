import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Client, InStatement, InValue, ResultSet, Transaction } from "@libsql/client";

/*
 * Turso mirror (ADR 0003). The host keeps working on a local SQLite file (synchronous code stays as it is);
 * every write that changed something locally is replayed on Turso in the same order, a transaction as one
 * batch. At start-up the local file is rebuilt from Turso. When a migration runs (or Turso is empty) the
 * whole database is written to Turso in one transaction.
 *
 * Foreign keys: a remote connection may not enforce them, so ON DELETE CASCADE is also expressed as
 * triggers on Turso ("_nxfk_*"); they never exist locally (SQLite does the cascade itself here).
 */

export interface Stmt { sql: string; args: InValue[] }
type Log = (...a: unknown[]) => void;

const META = "_nx_meta";
const FK_PREFIX = "_nxfk_";
const BATCH_STATEMENTS = 200;
const BATCH_BYTES = 2 * 1024 * 1024;
const PAGE = 500;

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const internal = (name: string) => /^(sqlite_|libsql_|_litestream)/.test(name) || name === META || name.startsWith(FK_PREFIX);

/** node:sqlite parameter -> libSQL value (byte views are copied: the caller may reuse its buffer). */
export function toInValue(v: SQLInputValue): InValue {
  if (v === null || typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** libSQL value -> node:sqlite parameter. */
function toLocal(v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return String(v);
}

function stmtBytes(s: Stmt): number {
  let n = s.sql.length;
  for (const a of s.args) n += a instanceof Uint8Array ? Math.ceil(a.byteLength * 1.4) : typeof a === "string" ? a.length : 8;
  return n;
}

/** Splits statements into request-sized batches. */
function chunks(list: Stmt[]): Stmt[][] {
  const out: Stmt[][] = [];
  let cur: Stmt[] = [], bytes = 0;
  for (const s of list) {
    const b = stmtBytes(s);
    if (cur.length && (cur.length >= BATCH_STATEMENTS || bytes + b > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(s);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

const isSqlError = (e: unknown): boolean => /^SQLITE_/.test(String((e as { code?: unknown })?.code ?? ""));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Mirror {
  private queue: Stmt[][] = [];
  private flushing: Promise<void> | null = null;
  private oneByOne = false;

  constructor(private client: Client, private log: Log) {}

  /** Statements that must apply together (one local transaction). */
  push(group: Stmt[]): void {
    if (!group.length) return;
    this.queue.push(group);
    this.flushing ??= this.flush().finally(() => { this.flushing = null; });
  }

  get pending(): number {
    return this.queue.reduce((n, g) => n + g.length, 0);
  }

  /** Waits until everything queued reached Turso (or the time is up). */
  async drain(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (this.queue.length && Date.now() < end) await (this.flushing ?? sleep(50));
    return !this.queue.length;
  }

  private async flush(): Promise<void> {
    let failures = 0;
    while (this.queue.length) {
      // Whole groups only; one group at a time after a statement error, to find the bad one.
      const take: Stmt[][] = [];
      let n = 0, bytes = 0;
      for (const g of this.queue) {
        const b = g.reduce((a, s) => a + stmtBytes(s), 0);
        if (take.length && (this.oneByOne || n + g.length > BATCH_STATEMENTS || bytes + b > BATCH_BYTES)) break;
        take.push(g);
        n += g.length;
        bytes += b;
      }
      try {
        const big = take.length === 1 && (n > BATCH_STATEMENTS || bytes > BATCH_BYTES);
        if (big) await this.inTransaction(take[0]!);
        else await this.client.batch(take.flat() as InStatement[], "write");
        this.queue.splice(0, take.length);
        if (failures) this.log(`[db] Turso reachable again, ${this.pending} statements queued`);
        failures = 0;
        if (this.oneByOne && take.length === 1) this.oneByOne = false;
      } catch (e) {
        if (isSqlError(e)) {
          if (take.length > 1) { this.oneByOne = true; continue; }
          // The local database accepted this, Turso did not: they differ now. Skip it, say so loudly.
          console.error("[db] Turso rejected a write, skipped:", (e as Error).message, take[0]!.map((s) => s.sql.slice(0, 120)));
          this.queue.shift();
          continue;
        }
        failures++;
        if (failures === 1 || failures % 10 === 0) this.log(`[db] Turso write failed (${(e as Error).message}), retrying; ${this.pending} statements queued`);
        await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
      }
    }
  }

  private async inTransaction(list: Stmt[]): Promise<void> {
    const tx = await this.client.transaction("write");
    try {
      for (const c of chunks(list)) await tx.batch(c as InStatement[]);
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  }
}

/**
 * Fills an empty local database from Turso. Returns the schema version stored there (0 = Turso is empty).
 * Rows keep their rowid so later writes and clean-ups address the same rows on both sides.
 */
export async function pullFromRemote(client: Client, raw: DatabaseSync, log: Log): Promise<number> {
  const master = await client.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL");
  const objs = master.rows
    .map((r) => ({ type: String(r.type), name: String(r.name), table: String(r.tbl_name), sql: String(r.sql) }))
    .filter((o) => !internal(o.name) && !internal(o.table));
  const tables = objs.filter((o) => o.type === "table");
  if (!tables.length) return 0;
  const meta = await client.execute(`SELECT value FROM ${META} WHERE key = 'schema_version'`).catch(() => null);
  const version = Number(meta?.rows[0]?.value ?? 0);
  if (!version) throw new Error("Turso database has tables but no NooXCord schema version: refusing to use it.");

  const started = Date.now();
  let rows = 0;
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("BEGIN");
  try {
    for (const t of tables) {
      raw.exec(t.sql);
      let after: number | bigint = -1;
      for (;;) {
        const rs: ResultSet = await client.execute({ sql: `SELECT rowid AS _nx_rowid, * FROM ${q(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`, args: [after] });
        if (!rs.rows.length) break;
        const cols = rs.columns.slice(1);
        const ins = raw.prepare(`INSERT INTO ${q(t.name)} (rowid, ${cols.map(q).join(", ")}) VALUES (${["?", ...cols.map(() => "?")].join(", ")})`);
        for (const r of rs.rows) {
          ins.run(...rs.columns.map((c) => toLocal(r[c])));
          rows++;
        }
        after = rs.rows[rs.rows.length - 1]!._nx_rowid as number | bigint;
        if (rs.rows.length < PAGE) break;
      }
    }
    for (const o of objs) if (o.type !== "table") raw.exec(o.sql);
    raw.exec(`PRAGMA user_version = ${version}`);
    raw.exec("COMMIT");
  } catch (e) {
    raw.exec("ROLLBACK");
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
  log(`[db] loaded ${rows} rows in ${tables.length} tables from Turso (schema ${version}) in ${Date.now() - started} ms`);
  return version;
}

/** ON DELETE CASCADE of the local schema as triggers, for a remote side that may not enforce foreign keys. */
function cascadeTriggers(raw: DatabaseSync): string[] {
  const out: string[] = [];
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name: child } of tables) {
    const fks = raw.prepare(`PRAGMA foreign_key_list(${q(child)})`).all() as { id: number; table: string; from: string; to: string | null; on_delete: string }[];
    const byId = new Map<number, typeof fks>();
    for (const f of fks) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
    for (const [id, cols] of byId) {
      const first = cols[0]!;
      if (first.on_delete.toUpperCase() !== "CASCADE") continue;
      const parent = first.table;
      const pk = (raw.prepare(`PRAGMA table_info(${q(parent)})`).all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const where = cols.map((c, i) => `${q(c.from)} = old.${q(c.to ?? pk[i] ?? "rowid")}`).join(" AND ");
      out.push(`CREATE TRIGGER ${q(`${FK_PREFIX}${parent}_${child}_${id}`)} AFTER DELETE ON ${q(parent)} BEGIN DELETE FROM ${q(child)} WHERE ${where}; END`);
    }
  }
  return out;
}

/** Replaces everything on Turso with the local database (fresh Turso, or after a migration). One transaction. */
export async function pushToRemote(client: Client, raw: DatabaseSync, version: number, log: Log): Promise<void> {
  const started = Date.now();
  const objs = (raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; sql: string }[]);
  const tables = objs.filter((o) => o.type === "table");
  const tx: Transaction = await client.transaction("write");
  let rows = 0;
  try {
    await tx.execute("PRAGMA defer_foreign_keys = ON");
    const existing = (await tx.execute("SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL")).rows
      .map((r) => ({ type: String(r.type), name: String(r.name) }))
      .filter((o) => !/^(sqlite_|libsql_|_litestream)/.test(o.name));
    const drops: Stmt[] = [];
    for (const kind of ["trigger", "view"]) for (const o of existing) if (o.type === kind) drops.push({ sql: `DROP ${kind.toUpperCase()} IF EXISTS ${q(o.name)}`, args: [] });
    // Tables children first: with foreign keys enforced, dropping a table whose parent is gone fails.
    const left = new Set(existing.filter((o) => o.type === "table").map((o) => o.name));
    const parents = new Map<string, Set<string>>();
    for (const t of left) {
      const fk = await tx.execute(`SELECT "table" FROM pragma_foreign_key_list(${q(t).replace(/"/g, "'")})`);
      parents.set(t, new Set(fk.rows.map((r) => String(r.table)).filter((p) => p !== t)));
    }
    while (left.size) {
      const leaves = [...left].filter((t) => ![...left].some((o) => o !== t && parents.get(o)?.has(t)));
      const next = leaves.length ? leaves : [...left]; // a cycle: drop the rest in any order
      for (const t of next) { drops.push({ sql: `DROP TABLE IF EXISTS ${q(t)}`, args: [] }); left.delete(t); }
    }
    for (const c of chunks(drops)) await tx.batch(c as InStatement[]);
    const ddl: Stmt[] = [{ sql: `CREATE TABLE ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`, args: [] }, ...tables.map((t) => ({ sql: t.sql, args: [] }))];
    await tx.batch(ddl as InStatement[]);
    for (const t of tables) {
      const cols = (raw.prepare(`PRAGMA table_info(${q(t.name)})`).all() as { name: string }[]).map((c) => c.name);
      const sql = `INSERT INTO ${q(t.name)} (rowid, ${cols.map(q).join(", ")}) VALUES (${["?", ...cols.map(() => "?")].join(", ")})`;
      let buf: Stmt[] = [];
      for (const r of raw.prepare(`SELECT rowid AS _nx_rowid, * FROM ${q(t.name)} ORDER BY rowid`).iterate() as Iterable<Record<string, SQLInputValue>>) {
        buf.push({ sql, args: [r._nx_rowid!, ...cols.map((c) => r[c] ?? null)].map(toInValue) });
        rows++;
        if (buf.length >= BATCH_STATEMENTS) { for (const c of chunks(buf)) await tx.batch(c as InStatement[]); buf = []; }
      }
      for (const c of chunks(buf)) await tx.batch(c as InStatement[]);
    }
    const rest: Stmt[] = [
      ...objs.filter((o) => o.type !== "table").map((o) => ({ sql: o.sql, args: [] })),
      ...cascadeTriggers(raw).map((sql) => ({ sql, args: [] })),
      { sql: `INSERT INTO ${META} (key, value) VALUES ('schema_version', ?)`, args: [String(version)] },
    ];
    for (const c of chunks(rest)) await tx.batch(c as InStatement[]);
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  } finally {
    tx.close();
  }
  log(`[db] wrote ${rows} rows in ${tables.length} tables to Turso (schema ${version}) in ${Date.now() - started} ms`);
}

/** Cleans rows whose parent is gone (should not happen; logged when it does), on both sides. */
export function orphanDeletes(raw: DatabaseSync): Stmt[] {
  const bad = raw.prepare("PRAGMA foreign_key_check").all() as { table: string; rowid: number | bigint | null }[];
  return bad.filter((b) => b.rowid !== null).map((b) => ({ sql: `DELETE FROM ${q(b.table)} WHERE rowid = ?`, args: [b.rowid!] }));
}
