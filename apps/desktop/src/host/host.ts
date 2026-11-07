// Entry point of the host utility process (Electron utilityProcess).
// Receives { type: "start", port, dataDir, webDir } and replies with "started" / "error".
import { startHost, type HostConfig, type RunningHost } from "@nooxcord/server";

interface ParentPort {
  on(e: "message", fn: (ev: { data: unknown }) => void): void;
  postMessage(m: unknown): void;
}
const port = (process as unknown as { parentPort: ParentPort }).parentPort;
let running: RunningHost | null = null;

port.on("message", async ({ data }) => {
  const msg = data as { type: string; port?: number; dataDir?: string; webDir?: string; config?: Partial<HostConfig> };
  if (msg.type === "start" && !running) {
    try {
      running = await startHost({ port: msg.port!, dataDir: msg.dataDir!, webDir: msg.webDir, config: msg.config });
      port.postMessage({ type: "started", port: running.port });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      port.postMessage({ type: "error", code: err.code ?? "ERR", message: err.message });
    }
  } else if (msg.type === "config") {
    running?.setConfig(msg.config ?? {});
  } else if (msg.type === "stop") {
    await running?.close().catch(() => {});
    running = null;
    port.postMessage({ type: "stopped" });
    process.exit(0);
  }
});
