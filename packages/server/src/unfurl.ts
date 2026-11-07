import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Embed } from "@nooxcord/shared";

/**
 * Link previews fetched by the host. Guards against SSRF: only http(s), only public addresses,
 * no redirects to private ranges, 4 s timeout, 512 KiB cap. The address is checked inside the
 * socket's own DNS lookup, so the checked IP is the one we connect to (no DNS-rebinding window).
 * Preview images are served through the host (/proxy/img) so viewers' IPs never reach third parties.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const MAX_BYTES = 512 * 1024;
const cache = new Map<string, { at: number; embed: Embed | null }>();

export function extractUrls(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[),.!?;:]+$/, "");
    if (!out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || a === 25; // 25.x = Hamachi
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

type LookupCb = (err: Error | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup used by the socket itself: refuses private answers. */
function safeLookup(hostname: string, options: { all?: boolean }, cb: LookupCb): void {
  dnsLookup(hostname, { all: true }, (err, list) => {
    if (err) return cb(err, "");
    if (list.length === 0 || list.some((a) => isPrivate(a.address))) return cb(new Error("private address"), "");
    if (options.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

function checkUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  if (url.username || url.password) throw new Error("credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivate(host)) throw new Error("private address");
}

interface Got { status: number; type: string; location: string | null; body: Buffer }

/** One GET, no redirects followed, body capped at max bytes. */
function get(url: URL, accept: string, max: number): Promise<Got> {
  checkUrl(url);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { lookup: safeLookup as never, timeout: 4000, headers: { "user-agent": "NooXCordBot/0.1 (link preview)", accept } }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers["content-type"] ?? "");
      const location = res.headers.location ?? null;
      if (status >= 300 && status < 400) {
        res.destroy();
        return resolve({ status, type, location, body: Buffer.alloc(0) });
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        total += c.length;
        if (total >= max) res.destroy();
      });
      res.on("close", () => resolve({ status, type, location, body: Buffer.concat(chunks).subarray(0, max) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** GET with up to 3 redirects, each hop re-checked. */
async function fetchSafe(start: string, accept: string, max: number): Promise<{ url: string; got: Got } | null> {
  let url = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    const got = await get(url, accept, max);
    if (got.status >= 300 && got.status < 400) {
      if (!got.location) return null;
      url = new URL(got.location, url);
      continue;
    }
    return got.status >= 200 && got.status < 300 ? { url: url.href, got } : null;
  }
  return null;
}

async function fetchLimited(start: string): Promise<{ url: string; html: string; type: string } | null> {
  const r = await fetchSafe(start, "text/html,image/*;q=0.8", MAX_BYTES);
  if (!r) return null;
  return { url: r.url, html: r.got.type.includes("text/html") ? r.got.body.toString("utf8") : "", type: r.got.type };
}

// ---------- image proxy ----------

let proxyKey: Buffer | null = null;
/** Key that signs proxy links, so the host is never an open proxy (persisted with the host data). */
export function setProxyKey(key: Buffer): void {
  proxyKey = key;
}

const sign = (u: string) => createHmac("sha256", proxyKey!).update(u).digest("base64url").slice(0, 22);

export function proxiedImage(u: string): string {
  if (!proxyKey) return u;
  return `/proxy/img/${sign(u)}/${Buffer.from(u).toString("base64url")}`;
}

const imgCache = new Map<string, { at: number; type: string; body: Buffer }>();
const IMG_MAX = 5 * 1024 * 1024;

/** Fetches a signed preview image; null when the signature, address or type is wrong. */
export async function proxyImage(sig: string, enc: string, sniff: (b: Buffer) => string | null): Promise<{ type: string; body: Buffer } | null> {
  if (!proxyKey) return null;
  const u = Buffer.from(enc, "base64url").toString("utf8");
  const want = Buffer.from(sign(u)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const hit = imgCache.get(u);
  if (hit && Date.now() - hit.at < 3600_000) return hit;
  const r = await fetchSafe(u, "image/*", IMG_MAX).catch(() => null);
  const type = r ? sniff(r.got.body) : null;
  if (!r || !type) return null;
  const entry = { at: Date.now(), type, body: r.got.body };
  imgCache.set(u, entry);
  let size = 0;
  for (const v of imgCache.values()) size += v.body.length;
  while (size > 40 * 1024 * 1024 && imgCache.size > 1) {
    const k = imgCache.keys().next().value!;
    size -= imgCache.get(k)!.body.length;
    imgCache.delete(k);
  }
  return entry;
}

// ---------- previews ----------

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'").trim();

function meta(html: string, keys: string[]): string | null {
  for (const k of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content).slice(0, 400);
  }
  return null;
}

export async function unfurl(url: string): Promise<Embed | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.embed;
  let embed: Embed | null = null;
  try {
    const r = await fetchLimited(url);
    if (r) {
      if (r.type.startsWith("image/")) embed = { url, title: null, description: null, image: proxiedImage(r.url), site: new URL(r.url).hostname };
      else if (r.html) {
        const t = r.html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1];
        const title = meta(r.html, ["og:title", "twitter:title"]) ?? (t ? decode(t) : null);
        const description = meta(r.html, ["og:description", "twitter:description", "description"]);
        let image = meta(r.html, ["og:image", "twitter:image"]);
        if (image) {
          try {
            const iu = new URL(image, r.url);
            image = iu.protocol === "https:" || iu.protocol === "http:" ? proxiedImage(iu.href) : null;
          } catch { image = null; }
        }
        const site = meta(r.html, ["og:site_name"]) ?? new URL(r.url).hostname;
        if (title || description || image) embed = { url, title, description, image, site };
      }
    }
  } catch {
    embed = null;
  }
  cache.set(url, { at: Date.now(), embed });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return embed;
}
