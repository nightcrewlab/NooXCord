import { execFile } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";

/*
 * Port availability, LAN / Hamachi addresses and the Hamachi service (CLAUDE.md §10.1, §10.3).
 * Hamachi has no CLI: we detect its adapter (25.x.x.x) and can start/stop its Windows service.
 */

export type PortStatus = "free" | "in_use" | "own" | "privileged" | "invalid";
export interface PortCheck {
  port: number;
  status: PortStatus;
  /** Process holding the port, when Windows tells us. */
  process: string | null;
  /** Media port (port + 1, UDP + TCP) is free too. */
  mediaFree: boolean;
}

const run = (file: string, args: string[], timeout = 5000) =>
  new Promise<string>((resolve) => execFile(file, args, { timeout, windowsHide: true }, (_e, out) => resolve(String(out ?? ""))));

function tcpFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT")); // no IPv6 at all = fine
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function udpFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: "udp4" });
    s.once("error", () => { s.close(); resolve(false); });
    s.bind({ port, address: "0.0.0.0", exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** Windows apps may hold [::]:port while 0.0.0.0:port looks free (CLAUDE.md §17.10): test all three. */
async function portFree(port: number): Promise<boolean> {
  for (const h of ["0.0.0.0", "::", "127.0.0.1"]) if (!(await tcpFree(port, h))) return false;
  return true;
}

async function processOnPort(port: number): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const out = await run("netstat", ["-ano", "-p", "TCP"]);
  const out6 = await run("netstat", ["-ano", "-p", "TCPv6"]);
  const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "m");
  const pid = (re.exec(out) ?? re.exec(out6))?.[1];
  if (!pid) return null;
  const task = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  const name = /^"([^"]+)"/.exec(task.trim())?.[1];
  return name ? `${name} (PID ${pid})` : `PID ${pid}`;
}

export async function checkPort(raw: unknown, ownPort: number | null): Promise<PortCheck> {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65534) return { port, status: "invalid", process: null, mediaFree: false };
  if (port < 1024) return { port, status: "privileged", process: null, mediaFree: false };
  if (port === ownPort) return { port, status: "own", process: null, mediaFree: true };
  const free = await portFree(port);
  const mediaFree = (await tcpFree(port + 1, "0.0.0.0")) && (await udpFree(port + 1));
  return { port, status: free ? "free" : "in_use", process: free ? null : await processOnPort(port), mediaFree };
}

/** First free pair (port, port + 1) from 47820 upward. */
export async function suggestPort(): Promise<number> {
  for (let p = 47820; p < 48800; p += 2) {
    if ((await portFree(p)) && (await tcpFree(p + 1, "0.0.0.0")) && (await udpFree(p + 1))) return p;
  }
  return 47820;
}

export interface Addresses {
  lan: { name: string; ip: string }[];
  hamachi: { ip: string | null; service: "running" | "stopped" | "missing" | "unknown" };
}

const isHamachi = (name: string, ip: string) => /hamachi/i.test(name) || ip.startsWith("25.");

export async function addresses(): Promise<Addresses> {
  const lan: Addresses["lan"] = [];
  let hamachiIp: string | null = null;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      if (isHamachi(name, a.address)) hamachiIp = a.address;
      else lan.push({ name, ip: a.address });
    }
  }
  let service: Addresses["hamachi"]["service"] = "unknown";
  if (process.platform === "win32") {
    const q = await run("sc", ["query", "Hamachi2Svc"]);
    service = /RUNNING/.test(q) ? "running" : /STOPPED|STOP_PENDING/.test(q) ? "stopped" : /1060/.test(q) ? "missing" : "unknown";
  }
  return { lan, hamachi: { ip: hamachiIp, service } };
}

/** Starts/stops the Hamachi service through an elevated helper (Windows asks for UAC consent). */
export async function hamachiService(start: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const verb = start ? "start" : "stop";
  await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Start-Process -FilePath sc.exe -ArgumentList '${verb}','Hamachi2Svc' -Verb RunAs -WindowStyle Hidden -Wait`,
  ], 60_000);
}
