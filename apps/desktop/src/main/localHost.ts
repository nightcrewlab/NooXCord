import { app, utilityProcess, type UtilityProcess } from "electron";
import os from "node:os";
import path from "node:path";
import { hosts } from "./hosts";

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

const webDir = () => (app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "../../../packages/client/dist"));

export function status(): LocalHostStatus {
  return current;
}

export function start(port: unknown): Promise<LocalHostStatus> {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return Promise.resolve({ ...current, error: "Port 1024–65535 arasında olmalı." });
  if (child) return Promise.resolve(current);
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(path.join(__dirname, "host.cjs"), [], { serviceName: "NooXCord Host", stdio: "inherit" });
    child = proc;
    const timer = setTimeout(() => finish({ running: false, port: null, lanAddresses: [], error: "Sunucu başlatılamadı (zaman aşımı)." }), 15_000);
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
        finish({ running: false, port: null, lanAddresses: [], error: m.code === "EADDRINUSE" ? `Port ${p} kullanımda. Başka bir port deneyin.` : `Sunucu hatası: ${m.message}` });
      }
    });
    proc.on("exit", () => {
      if (child === proc) {
        child = null;
        current = { running: false, port: null, lanAddresses: [] };
      }
    });
    proc.postMessage({ type: "start", port: p, dataDir: path.join(app.getPath("userData"), "host"), webDir: webDir() });
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

/** Stops the host without changing the auto-start preference (app quit). */
export function shutdown(): void {
  child?.postMessage({ type: "stop" });
}
