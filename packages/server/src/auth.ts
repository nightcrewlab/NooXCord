import { createHash, scrypt as scryptCb, timingSafeEqual, randomBytes, type ScryptOptions } from "node:crypto";
import type { AuthResponse } from "@nooxcord/shared";
import { LoginBody, RegisterBody } from "@nooxcord/shared/schemas";
import type { Db } from "./db";
import type { Store, UserRow } from "./store";
import { fail, newId, randomToken } from "./util";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));

// scrypt N=2^15, r=8, p=1 (~32 MiB, ~60 ms) — Node built-in, no native addon.
const N = 1 << 15, R = 8, PAR = 1, KEYLEN = 32;
const SESSION_TTL = 90 * 24 * 3600 * 1000;
const SLIDE_AFTER = 24 * 3600 * 1000;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: PAR, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${PAR}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Simple per-login lockout: 5 failures -> 5 minutes. */
const failures = new Map<string, { count: number; until: number }>();

export class Auth {
  constructor(private db: Db, private store: Store) {}

  async register(body: unknown, userAgent: string | undefined): Promise<AuthResponse> {
    const b = RegisterBody.parse(body);
    if (this.db.get("SELECT 1 FROM users WHERE nickname = ?", b.nickname)) fail("conflict", "Bu kullanıcı adı alınmış.");
    if (this.db.get("SELECT 1 FROM users WHERE email = ?", b.email)) fail("conflict", "Bu e-posta ile kayıtlı bir hesap var.");
    const hash = await hashPassword(b.password);
    const id = newId();
    this.db.run("INSERT INTO users (id, nickname, email, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, b.nickname, b.email, hash, Date.now());
    const token = this.createSession(id, userAgent);
    return { token, user: this.store.selfUser(this.store.userRow(id)!) };
  }

  async login(body: unknown, userAgent: string | undefined): Promise<AuthResponse> {
    const b = LoginBody.parse(body);
    const key = b.login.toLowerCase();
    const f = failures.get(key);
    if (f && f.until > Date.now()) fail("rate_limited", "Çok fazla hatalı deneme. Birkaç dakika sonra tekrar deneyin.");
    const row = this.db.get<UserRow>("SELECT * FROM users WHERE (email = ?1 OR nickname = ?1) AND guest = 0", b.login);
    const ok = row?.pass_hash ? await verifyPassword(b.password, row.pass_hash) : (await hashPassword(b.password), false);
    if (!row || !ok) {
      const cur = failures.get(key) ?? { count: 0, until: 0 };
      cur.count++;
      if (cur.count >= 5) { cur.until = Date.now() + 5 * 60_000; cur.count = 0; }
      failures.set(key, cur);
      fail("unauthorized", "E-posta/kullanıcı adı veya şifre hatalı.");
    }
    failures.delete(key);
    const token = this.createSession(row!.id, userAgent);
    return { token, user: this.store.selfUser(row!) };
  }

  createSession(userId: string, userAgent: string | undefined): string {
    const token = randomToken(32);
    const now = Date.now();
    this.db.run(
      "INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      newId(), userId, sha256(token), userAgent?.slice(0, 200) ?? null, now, now, now + SESSION_TTL,
    );
    return token;
  }

  /** Returns the user id for a valid token and slides its expiry. */
  resolve(token: string | undefined): string | null {
    if (!token || token.length > 200) return null;
    const s = this.db.get<{ id: string; user_id: string; last_used_at: number; expires_at: number }>(
      "SELECT id, user_id, last_used_at, expires_at FROM sessions WHERE token_hash = ?",
      sha256(token),
    );
    const now = Date.now();
    if (!s || s.expires_at < now) return null;
    if (now - s.last_used_at > SLIDE_AFTER) this.db.run("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?", now, now + SESSION_TTL, s.id);
    return s.user_id;
  }

  logout(token: string): void {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  }
}
