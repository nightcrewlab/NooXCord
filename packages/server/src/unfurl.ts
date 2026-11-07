import { lookup } from "node:dns/promises";
import net from "node:net";
import type { Embed } from "@nooxcord/shared";

/**
 * Link previews fetched by the host. Guards against SSRF: only http(s), only public addresses,
 * no redirects to private ranges, 4 s timeout, 512 KiB cap.
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

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  if (url.username || url.password) throw new Error("credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivate(a.address))) throw new Error("private address");
}

async function fetchLimited(start: string): Promise<{ url: string; html: string; type: string } | null> {
  let url = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
      headers: { "user-agent": "NooXCordBot/0.1 (link preview)", accept: "text/html,image/*;q=0.8" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) return null;
      url = new URL(loc, url);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body) return null;
    if (!type.includes("text/html")) {
      await res.body.cancel();
      return { url: url.href, html: "", type };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    return { url: url.href, html: Buffer.concat(chunks).toString("utf8"), type };
  }
  return null;
}

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
      if (r.type.startsWith("image/")) embed = { url, title: null, description: null, image: r.url, site: new URL(r.url).hostname };
      else if (r.html) {
        const title = meta(r.html, ["og:title", "twitter:title"]) ?? (r.html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] ? decode(r.html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)![1]!) : null);
        const description = meta(r.html, ["og:description", "twitter:description", "description"]);
        let image = meta(r.html, ["og:image", "twitter:image"]);
        if (image) {
          try {
            const iu = new URL(image, r.url);
            image = iu.protocol === "https:" || iu.protocol === "http:" ? iu.href : null;
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
