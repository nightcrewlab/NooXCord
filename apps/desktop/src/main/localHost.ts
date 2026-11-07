import { app, utilityProcess, type UtilityProcess } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hosts } from "./hosts";
import { s } from "./strings";

/** Runs the NooXCord host server in a separate utility process so the UI never blocks. */
export interface LocalHostStatus {
  running: boolean;
  port: number | null;
  lanAddresses: string[];
  error?: string;
}

let child: UtilityProcess | null = null;
let current: LocalHostStatus = { running: false, port: null, lanAddresses: [] };

function lanAddresses(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(`${a.address}:${port}`);
    }
  }
  return out;
}

/** mediasoup worker: unpacked next to app.asar when installed (mediasoup cannot find it there by itself). */
export const workerBin = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "mediasoup", "worker", "out", "Release", "mediasoup-worker.exe")
    : path.join(__dirname, "../../../node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe");
const hostEnv = (): NodeJS.ProcessEnv => (app.isPackaged ? { ...process.env, MEDIASOUP_WORKER_BIN: workerBin() } : process.env);
const webDir = () => (app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "../../../packages/client/dist"));

/** Host process output goes to %APPDATA%/NooXCord/logs/host.log (rotated at 2 MB) for "what went wrong" reports. */
function pipeLog(proc: UtilityProcess): void {
  const dir = path.join(app.getPath("userData"), "logs");
  const file = path.join(dir, "host.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + ".1");
  } catch { /* logging is best effort */ }
  const out = fs.createWriteStream(file, { flags: "a" });
  out.on("error", () => {});
  const stamp = () => new Date().toISOString();
  out.write(`\n${stamp()} ---- host started ----\n`);
  const tee = (chunk: Buffer, std: NodeJS.WriteStream) => {
    out.write(String(chunk).split(/\r?\n/).filter(Boolean).map((l) => `${stamp()} ${l}\n`).join(""));
    if (!app.isPackaged) std.write(chunk);
  };
  proc.stdout?.on("data", (c: Buffer) => tee(c, process.stdout));
  proc.stderr?.on("data", (c: Buffer) => tee(c, process.stderr));
  proc.on("exit", (code) => { out.end(`${stamp()} ---- host exited (${code}) ----\n`); });
}

/** Host-owner settings handed to the server (never changeable over the network). */
function hostConfig() {
  const p = hosts.localHostPrefs();
  return { allowGuests: p.allowGuests, guestPassword: p.guestPassword || null };
}

/** Push changed guest settings to the running host. */
export function pushConfig(): void {
  child?.postMessage({ type: "config", config: hostConfig() });
}

export function status(): LocalHostStatus {
  return current;
}

export function start(port: unknown): Promise<LocalHostStatus> {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return Promise.resolve({ ...current, error: s("main.err.portRange") });
  if (child) return Promise.resolve(current);
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(path.join(__dirname, "host.cjs"), [], { serviceName: "NooXCord Host", stdio: "pipe", env: hostEnv() });
    child = proc;
    pipeLog(proc);
    const timer = setTimeout(() => finish({ running: false, port: null, lanAddresses: [], error: s("main.err.hostTimeout") }), 15_000);
    const finish = (st: LocalHostStatus) => {
      clearTimeout(timer);
      current = st;
      if (!st.running) {
        proc.kill();
        child = null;
      }
      resolve(st);
    };
    proc.on("message", (m: { type: string; port?: number; code?: string; message?: string }) => {
      if (m.type === "started") {
        hosts.setLocalHostPrefs({ autoStart: true, port: m.port! });
        finish({ running: true, port: m.port!, lanAddresses: lanAddresses(m.port!) });
      } else if (m.type === "error") {
        finish({ running: false, port: null, lanAddresses: [], error: m.code === "EADDRINUSE" ? s("main.err.portBusy", { port: p }) : s("main.err.host", { msg: m.message ?? "" }) });
      }
    });
    proc.on("exit", () => {
      if (child === proc) {
        child = null;
        current = { running: false, port: null, lanAddresses: [] };
      }
    });
    proc.postMessage({ type: "start", port: p, dataDir: hostDataDir(), webDir: webDir(), config: hostConfig() });
  });
}

export function stop(): Promise<LocalHostStatus> {
  hosts.setLocalHostPrefs({ autoStart: false });
  const proc = child;
  if (!proc) return Promise.resolve(current);
  return new Promise((resolve) => {
    const done = () => {
      child = null;
      current = { running: false, port: null, lanAddresses: [] };
      resolve(current);
    };
    const kill = setTimeout(() => { proc.kill(); done(); }, 4000);
    proc.once("exit", () => { clearTimeout(kill); done(); });
    proc.postMessage({ type: "stop" });
  });
}

export const hostDataDir = (): string => path.join(app.getPath("userData"), "host");

/** Asks the running host for a database snapshot; null when the host is not running. */
export function requestBackup(tag?: string): Promise<{ name: string; size: number; at: number } | null> {
  const proc = child;
  if (!proc || !current.running) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onMsg = (m: { type: string; ok?: boolean; info?: { name: string; size: number; at: number }; error?: string }) => {
      if (m.type !== "backup") return;
      proc.off("message", onMsg);
      clearTimeout(timer);
      if (m.ok && m.info) resolve(m.info);
      else reject(new Error(m.error ?? "backup failed"));
    };
    const timer = setTimeout(() => { proc.off("message", onMsg); reject(new Error("backup timed out")); }, 30_000);
    proc.on("message", onMsg);
    proc.postMessage({ type: "backup", tag });
  });
}

/** Stops the host without changing the auto-start preference (app quit). */
export function shutdown(): void {
  child?.postMessage({ type: "stop" });
}
