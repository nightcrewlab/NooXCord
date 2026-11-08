import { BrowserWindow, Notification, clipboard, globalShortcut, ipcMain } from "electron";
import { hosts } from "./hosts";
import * as localHost from "./localHost";
import { addresses, checkPort, firewallAllow, hamachiService, suggestPort } from "./network";
import { TunnelManager, type TunnelProviderId } from "./tunnel";
import { s } from "./strings";

/* Settings → Connection: port, guests, Hamachi and tunnels (CLAUDE.md §10). */

let tunnel: TunnelManager | null = null;

const broadcast = (channel: string, data: unknown) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, data);
};

export function registerNetIpc(): void {
  tunnel = new TunnelManager({
    prefs: () => {
      const p = hosts.localHostPrefs();
      return { provider: p.tunnelProvider, devTunnelId: p.devTunnelId };
    },
    setPrefs: (p) => hosts.setLocalHostPrefs({
      ...(p.provider ? { tunnelProvider: p.provider } : {}),
      ...("devTunnelId" in p ? { devTunnelId: p.devTunnelId ?? null } : {}),
    }),
    onState: (s) => {
      broadcast("tunnel:state", s);
      localHost.setTunnelUrl(s.status === "on" && s.url ? s.url : null);
    },
    onUrl: (url) => {
      if (hosts.localHostPrefs().copyTunnelUrl) clipboard.writeText(url);
      if (Notification.isSupported()) {
        new Notification({ title: s("main.tunnel.openTitle"), body: hosts.localHostPrefs().copyTunnelUrl ? `${url}\n${s("main.tunnel.copied")}` : url, silent: true }).show();
      }
    },
  });

  const ownPort = () => (localHost.status().running ? localHost.status().port : null);

  ipcMain.handle("net:checkPort", (_e, port) => checkPort(port, ownPort()));
  ipcMain.handle("net:suggestPort", () => suggestPort());
  ipcMain.handle("net:addresses", () => addresses());
  ipcMain.handle("net:hamachiService", async (_e, start) => {
    await hamachiService(!!start);
    return addresses();
  });

  ipcMain.handle("net:firewallAllow", async () => {
    await firewallAllow([process.execPath, localHost.workerBin()]);
    return addresses();
  });

  ipcMain.handle("hostPrefs:get", () => {
    const p = hosts.localHostPrefs();
    return { allowGuests: p.allowGuests, guestPassword: p.guestPassword ?? "", copyTunnelUrl: p.copyTunnelUrl };
  });
  ipcMain.handle("hostPrefs:set", (_e, raw) => {
    const v = (raw ?? {}) as { allowGuests?: unknown; guestPassword?: unknown; copyTunnelUrl?: unknown };
    const patch: Parameters<typeof hosts.setLocalHostPrefs>[0] = {};
    if (typeof v.allowGuests === "boolean") patch.allowGuests = v.allowGuests;
    if (typeof v.guestPassword === "string") patch.guestPassword = v.guestPassword.slice(0, 128) || null;
    if (typeof v.copyTunnelUrl === "boolean") patch.copyTunnelUrl = v.copyTunnelUrl;
    hosts.setLocalHostPrefs(patch);
    localHost.pushConfig();
  });

  /** Restart the host on another port; the tunnel follows. */
  ipcMain.handle("localHost:restart", async (_e, port) => {
    await localHost.stop();
    const st = await localHost.start(port);
    if (st.running && st.port) await tunnel?.restart(st.port);
    else tunnel?.stop();
    return st;
  });

  ipcMain.handle("tunnel:get", () => tunnel!.get());
  ipcMain.handle("tunnel:setProvider", (_e, p: TunnelProviderId) => {
    if (p === "cloudflare" || p === "devtunnel") tunnel!.setProvider(p);
  });
  ipcMain.handle("tunnel:start", async () => {
    const st = localHost.status();
    if (!st.running || !st.port) throw new Error(s("main.err.startHostFirst"));
    await tunnel!.start(st.port);
  });
  ipcMain.handle("tunnel:stop", () => tunnel!.stop());
  ipcMain.handle("tunnel:copy", () => copyUrl());
  ipcMain.handle("tunnel:devRefresh", () => tunnel!.refreshDev());
  ipcMain.handle("tunnel:devInstall", () => tunnel!.installDev());
  ipcMain.handle("tunnel:devLogin", () => tunnel!.loginDev());
  ipcMain.handle("tunnel:devLogout", () => tunnel!.logoutDev());
  ipcMain.handle("tunnel:devNewUrl", () => tunnel!.newDevUrl());
}

function copyUrl(): boolean {
  const url = tunnel?.get().url;
  if (!url) return false;
  clipboard.writeText(url);
  return true;
}

/** Ctrl+Shift+L copies the public URL from anywhere. */
export function registerNetShortcuts(): void {
  globalShortcut.register("CommandOrControl+Shift+L", () => {
    if (copyUrl() && Notification.isSupported()) new Notification({ title: "NooXCord", body: s("main.tunnel.copied"), silent: true }).show();
  });
}

/** The host stopped: a tunnel to nothing is useless. */
export function hostStopped(): void {
  tunnel?.stop();
}

export function shutdownNet(): void {
  tunnel?.stop();
}
