import type { IceServer } from "@nooxcord/shared";

/*
 * STUN / TURN servers handed to clients on voice.join (ADR 0003). STUN finds a direct path for most
 * home connections; behind symmetric NAT / CGNAT (many mobile lines) only a TURN relay gets through.
 *
 *   NX_ICE_SERVERS              JSON array of RTCIceServer, replaces everything below
 *   TURN_URLS                   comma separated turn:/turns: URLs, with TURN_USERNAME + TURN_CREDENTIAL
 *   CLOUDFLARE_TURN_KEY_ID      Cloudflare Realtime TURN key, with CLOUDFLARE_TURN_API_TOKEN:
 *                               short-lived credentials are generated (cached for half their lifetime)
 */

const DEFAULT_STUN: IceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
const CF_TTL = 24 * 3600;

const isIce = (x: unknown): x is IceServer => {
  const o = x as IceServer;
  return !!o && (typeof o.urls === "string" || (Array.isArray(o.urls) && o.urls.every((u) => typeof u === "string")));
};

export function iceConfig(env: NodeJS.ProcessEnv, log: (...a: unknown[]) => void = () => {}): () => Promise<IceServer[]> {
  if (env.NX_ICE_SERVERS) {
    try {
      const list = JSON.parse(env.NX_ICE_SERVERS) as unknown;
      if (Array.isArray(list) && list.every(isIce)) return async () => list;
    } catch { /* fall through */ }
    log("[ice] NX_ICE_SERVERS is not a JSON array of ICE servers, ignored");
  }
  const base = [...DEFAULT_STUN];
  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    base.push({ urls: env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  const keyId = env.CLOUDFLARE_TURN_KEY_ID, token = env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) {
    log(`[ice] ${base.length > DEFAULT_STUN.length ? "STUN + TURN" : "STUN only (no TURN relay configured)"}`);
    return async () => base;
  }
  log("[ice] STUN + Cloudflare TURN");
  let cache: { at: number; list: IceServer[] } | null = null;
  let pending: Promise<IceServer[]> | null = null;
  const fetchCf = async (): Promise<IceServer[]> => {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: CF_TTL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
    const body = (await res.json()) as { iceServers?: unknown };
    const raw = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    const list = raw.filter(isIce);
    if (!list.length) throw new Error("Cloudflare TURN: no ICE servers in the answer");
    return list;
  };
  return async () => {
    if (cache && Date.now() - cache.at < (CF_TTL * 1000) / 2) return [...base, ...cache.list];
    pending ??= fetchCf()
      .then((list) => { cache = { at: Date.now(), list }; return list; })
      .catch((e: unknown) => { log(`[ice] ${(e as Error).message}; STUN only for now`); return cache?.list ?? []; })
      .finally(() => { pending = null; });
    return [...base, ...(await pending)];
  };
}
