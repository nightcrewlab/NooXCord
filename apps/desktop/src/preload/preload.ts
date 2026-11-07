import { contextBridge, ipcRenderer } from "electron";

// Typed bridge consumed by packages/client/src/platform. Only these channels exist.
const call = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

contextBridge.exposeInMainWorld("nx", {
  platform: "desktop",
  version: process.env.NX_APP_VERSION ?? "0.1.0",
  hosts: {
    list: () => call("hosts:list"),
    save: (h: unknown) => call("hosts:save", h),
    remove: (url: string) => call("hosts:remove", url),
    getToken: (url: string) => call("hosts:getToken", url),
    setToken: (url: string, token: string | null) => call("hosts:setToken", url, token),
    getLast: () => call("hosts:getLast"),
    setLast: (url: string | null) => call("hosts:setLast", url),
  },
  localHost: {
    status: () => call("localHost:status"),
    start: (port: number) => call("localHost:start", port),
    stop: () => call("localHost:stop"),
    restart: (port: number) => call("localHost:restart", port),
    getPrefs: () => call("hostPrefs:get"),
    setPrefs: (p: unknown) => call("hostPrefs:set", p),
  },
  net: {
    checkPort: (port: number) => call("net:checkPort", port),
    suggestPort: () => call("net:suggestPort"),
    addresses: () => call("net:addresses"),
    hamachiService: (start: boolean) => call("net:hamachiService", start),
  },
  tunnel: {
    get: () => call("tunnel:get"),
    setProvider: (p: string) => call("tunnel:setProvider", p),
    start: () => call("tunnel:start"),
    stop: () => call("tunnel:stop"),
    copy: () => call("tunnel:copy"),
    devRefresh: () => call("tunnel:devRefresh"),
    devInstall: () => call("tunnel:devInstall"),
    devLogin: () => call("tunnel:devLogin"),
    devLogout: () => call("tunnel:devLogout"),
    devNewUrl: () => call("tunnel:devNewUrl"),
    onState: (cb: (s: unknown) => void) => {
      const fn = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on("tunnel:state", fn);
      return () => ipcRenderer.removeListener("tunnel:state", fn);
    },
  },
  openExternal: (url: string) => call("shell:openExternal", url),
  media: {
    getSources: () => call("media:getSources"),
    selectSource: (id: string) => call("media:selectSource", id),
    systemAudioSupported: () => call("media:systemAudioSupported"),
    startSystemAudio: () => call("media:startSystemAudio"),
    stopSystemAudio: () => call("media:stopSystemAudio"),
    setPttKey: (code: string | null) => call("media:setPttKey", code),
    onPtt: (cb: (down: boolean) => void) => {
      const fn = (_e: unknown, down: boolean) => cb(!!down);
      ipcRenderer.on("media:ptt", fn);
      return () => ipcRenderer.removeListener("media:ptt", fn);
    },
    setInCall: (active: boolean) => call("media:setInCall", active),
  },
  overlay: {
    update: (members: unknown) => ipcRenderer.send("overlay:update", members),
  },
});

// MessagePorts cannot cross contextBridge; hand the system-audio port to the page via postMessage.
ipcRenderer.on("media:sysaudio-port", (e) => {
  window.postMessage("nx:sysaudio-port", "*", e.ports);
});
