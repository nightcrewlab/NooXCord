// Host entry point: Render.com (ADR 0003) and local development (`pnpm dev:host`).
//
//   PORT                     listening port (Render sets it)              default 47820
//   NX_DATA                  local working copy of the database           default packages/server/.data
//   NX_WEB                   built web client to serve                    default packages/client/dist
//   TURSO_DATABASE_URL       libsql://… — with TURSO_AUTH_TOKEN: data kept in Turso (without: local file only)
//   NX_NAME                  server name shown to clients                 default "NooXCord"
//   NX_ALLOW_REGISTRATION    "0" closes sign-up                           default open
//   NX_ALLOW_GUESTS          "0" closes browser guest login               default open
//   NX_GUEST_PASSWORD        password browser guests must enter           default none
//   ICE servers for voice: see ice.ts (NX_ICE_SERVERS, TURN_*, CLOUDFLARE_TURN_*)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "@nooxcord/shared";
import { iceConfig } from "./ice";
import { startHost } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

let remote: import("@libsql/client").Client | undefined;
if (env.TURSO_DATABASE_URL) {
  // The web client needs no native module (fetch only), so the bundle runs anywhere.
  const { createClient } = await import("@libsql/client/web");
  remote = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  log(`[db] Turso: ${new URL(env.TURSO_DATABASE_URL.replace(/^libsql:/, "https:")).host}`);
} else log("[db] no TURSO_DATABASE_URL: local database only (lost when the host's disk is wiped)");

const host = await startHost({
  dataDir: env.NX_DATA ?? path.resolve(here, "../.data"),
  port: Number(env.PORT ?? DEFAULT_PORT),
  webDir: env.NX_WEB ?? path.resolve(here, "../../client/dist"),
  name: env.NX_NAME ?? "NooXCord",
  logger: env.NX_LOG === "1",
  remote,
  iceServers: iceConfig(env, log),
  log,
  config: {
    allowRegistration: env.NX_ALLOW_REGISTRATION !== "0",
    allowGuests: env.NX_ALLOW_GUESTS !== "0",
    guestPassword: env.NX_GUEST_PASSWORD || null,
  },
});
log(`NooXCord host listening on port ${host.port}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void host.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
