import { contextBridge, ipcRenderer } from "electron";

// Overlay window bridge: receives the member list from the main process.
contextBridge.exposeInMainWorld("nxOverlay", {
  onState: (cb: (list: unknown) => void) => {
    ipcRenderer.on("overlay:state", (_e, list) => cb(list));
  },
});
