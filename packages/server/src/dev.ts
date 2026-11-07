// Standalone host for development: `pnpm --filter @nooxcord/server dev`
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "@nooxcord/shared";
import { startHost } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
const host = await startHost({
  dataDir: process.env.NX_DATA ?? path.resolve(here, "../.data"),
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  webDir: path.resolve(here, "../../client/dist"),
  logger: process.env.NX_LOG === "1",
});
console.log(`NooXCord host listening on http://localhost:${host.port}`);
const stop = () => void host.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
