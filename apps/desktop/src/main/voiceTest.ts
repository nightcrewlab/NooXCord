import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";

/*
 * Voice check, headless: three users (separate in-memory sessions) join one voice channel and connect
 * to each other directly (P2P mesh, ADR 0003); two of them stream, everybody watches every other
 * stream. Microphones and cameras are Chromium fake devices, screens are animated canvases.
 * Without NX_UITEST_HOST the test runs the server bundle (packages/server/dist/server.mjs) itself.
 *   NX_SELFTEST=voice [NX_UITEST_HOST=http://127.0.0.1:47820] [NX_SHOT=out.png] electron apps/desktop
 */

const log = (...a: unknown[]) => console.log("[voicetest]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function prepareVoiceTest(): void {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
}

async function openUser(host: string, name: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { partition: `nxtest-${name}-${Date.now()}`, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL(host);
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const reg = await js(`fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: ${JSON.stringify(name)}, email: ${JSON.stringify(name.toLowerCase() + "@test.local")}, password: "testtest123" }) }).then(r => r.json())`);
  if (!reg.token) throw new Error(`register ${name}: ${JSON.stringify(reg)}`);
  await js(`localStorage.setItem("nx.token:" + location.origin, ${JSON.stringify(reg.token)})`);
  await win.loadURL(host);
  for (let i = 0; i < 50; i++) {
    if (await js(`!!window.__nx && window.__nx.useStore.getState().connStatus === "ready"`)) return win;
    await sleep(200);
  }
  const diag = await js(`JSON.stringify({ nx: !!window.__nx, st: window.__nx && window.__nx.useStore.getState().connStatus, screen: window.__nx && window.__nx.useStore.getState().screen, body: document.body.innerText.slice(0, 200) })`);
  throw new Error(`${name} never became ready: ${diag}`);
}

const call = (win: BrowserWindow, m: string, d: unknown) =>
  win.webContents.executeJavaScript(`window.__nx.useStore.getState().conn.call(${JSON.stringify(m)}, ${JSON.stringify(d)})`);

/** Starts a screen share from an animated canvas (stand-in for desktopCapturer). */
const shareCanvas = (win: BrowserWindow, color: string, tone = false) =>
  win.webContents.executeJavaScript(`(async () => {
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
    const g = c.getContext("2d"); let f = 0;
    setInterval(() => { f++; g.fillStyle = ${JSON.stringify(color)}; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = "#fff"; g.font = "bold 96px sans-serif"; g.fillText("NooXCord test " + f, 80 + (f * 7) % 400, 380); }, 33);
    const track = c.captureStream(30).getVideoTracks()[0];
    let testAudio;
    if (${tone}) {
      const ac = new AudioContext({ sampleRate: 48000 }); const o = ac.createOscillator(); o.frequency.value = 440;
      const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); testAudio = d.stream.getAudioTracks()[0];
    }
    await window.__nx.voice.startScreen({ preset: "low", contentHint: "motion", audio: !!testAudio, testTrack: track, testAudio });
    return window.__nx.useVoice.getState().sharing;
  })()`);

/** Runs the server bundle with Electron's own Node (ELECTRON_RUN_AS_NODE) on a fresh data folder. */
async function startServer(port: number): Promise<{ url: string; proc: ChildProcess }> {
  const root = path.join(__dirname, "../../..");
  const bundle = path.join(root, "packages/server/dist/server.mjs");
  if (!fs.existsSync(bundle)) throw new Error("server bundle missing: run pnpm --filter @nooxcord/server build");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "nx-voicetest-"));
  const proc = spawn(process.execPath, [bundle], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port), NX_DATA: data, NX_WEB: path.join(root, "packages/client/dist"), TURSO_DATABASE_URL: "" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    if (await fetch(url + "/api/info").then((r) => r.ok, () => false)) return { url, proc };
  }
  proc.kill();
  throw new Error("server did not start");
}

export async function voiceSelfTest(): Promise<void> {
  let host = process.env.NX_UITEST_HOST;
  let server: ChildProcess | null = null;
  if (!host) {
    try {
      const s = await startServer(Number(process.env.NX_SELFTEST_PORT ?? 47850));
      host = s.url;
      server = s.proc;
      log("using server bundle", host);
    } catch (e) {
      log("✗ server", (e as Error).message);
      return app.exit(1);
    }
  }
  const results: [string, boolean, string?][] = [];
  const check = (name: string, ok: boolean, info?: string) => {
    results.push([name, ok, info]);
    log(ok ? "✓" : "✗", name, info ?? "");
  };
  const js = <T = unknown>(w: BrowserWindow, code: string): Promise<T> => w.webContents.executeJavaScript(code) as Promise<T>;
  /** Frames a MediaStream from the engine plays over 2.5 s in a real <video>. */
  const frames = (w: BrowserWindow, expr: string) => js<{ n: number; w: number; h: number }>(w, `(async () => {
    const s = ${expr}; if (!s) return { n: -1, w: 0, h: 0 };
    const v = document.createElement("video"); v.muted = true; v.srcObject = s;
    await Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    document.body.appendChild(v); v.style.cssText = "position:fixed;left:0;top:0;width:160px;height:90px";
    await new Promise((r) => setTimeout(r, 500));
    const q0 = v.getVideoPlaybackQuality().totalVideoFrames;
    await new Promise((r) => setTimeout(r, 2500));
    const n = v.getVideoPlaybackQuality().totalVideoFrames - q0;
    v.remove(); return { n, w: v.videoWidth, h: v.videoHeight };
  })()`);
  try {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [a, b, c] = (await Promise.all(["Ayse", "Mert", "Zeynep"].map((n) => openUser(host, `${n}_${suffix}`)))) as [BrowserWindow, BrowserWindow, BrowserWindow];
    const gs = await call(a, "guild.create", { name: "Ses Testi" });
    const guildId = gs.guild.id as string;
    const vc = gs.channels.find((x: { kind: string }) => x.kind === "voice").id as string;
    const inv = await call(a, "invite.create", { guildId });
    await call(b, "invite.join", { code: inv.code });
    await call(c, "invite.join", { code: inv.code });
    const ids: string[] = await Promise.all([a, b, c].map((w) => js<string>(w, `window.__nx.useStore.getState().me.id`)));
    const [ida, idb, idc] = ids as [string, string, string];
    const G = JSON.stringify(guildId);
    const V = JSON.stringify(vc);

    // A joins first, B and C a moment later: offers go both ways (the smaller id offers).
    await js(a, `window.__nx.voice.join(${G}, ${V})`);
    await sleep(300);
    for (const w of [b, c]) await js(w, `window.__nx.voice.join(${G}, ${V})`);
    const linksOf = (w: BrowserWindow) => js<Record<string, { state: string; screen: boolean }>>(w, `window.__nx.voice.debugLinks()`);
    const allUp = (m: Record<string, { state: string }>, n: number) => Object.values(m).length === n && Object.values(m).every((l) => l.state === "connected");
    let mesh: Record<string, { state: string }>[] = [];
    for (let i = 0; i < 40; i++) {
      mesh = await Promise.all([a, b, c].map(linksOf));
      if (mesh.every((m) => allUp(m, 2))) break;
      await sleep(250);
    }
    const statuses = await Promise.all([a, b, c].map((w) => js<string>(w, `window.__nx.useVoice.getState().status`)));
    check("3 users in voice", statuses.every((s) => s === "connected"), statuses.join(","));
    check("P2P mesh: everyone connected to everyone", mesh.every((m) => allUp(m, 2)), JSON.stringify(mesh.map((m) => Object.values(m).map((l) => l.state))));
    const seen = await js<number>(c, `window.__nx.useStore.getState().guilds[${G}].voice.length`);
    check("voice states broadcast to members", seen === 3, `C sees ${seen}`);

    // A streams with VP9, B with the automatic choice; the viewers' own setting (automatic) must not matter.
    await js(a, `window.__nx.useVoiceSettings.getState().set({ streamCodec: "vp9" })`);
    const sa = await shareCanvas(a, "#7a2e12");
    const sb = await shareCanvas(b, "#123a7a", true);
    check("A and B started streams", !!sa && !!sb, `${JSON.stringify(sa)} ${JSON.stringify(sb)}`);
    await sleep(1200);
    const thumbs = await js<boolean[]>(c, `window.__nx.useStore.getState().guilds[${G}].voice.filter(v => v.stream).map(v => !!v.stream.thumbnail)`);
    check("two streams listed with one-off thumbnails", thumbs.length === 2 && thumbs.every(Boolean), JSON.stringify(thumbs));
    const noViewers = await linksOf(a);
    check("no viewer, no screen sent", Object.values(noViewers).every((l) => !l.screen), JSON.stringify(noViewers));

    await js(a, `window.__nx.voice.watch(${JSON.stringify(idb)})`);
    await js(b, `window.__nx.voice.watch(${JSON.stringify(ida)})`);
    await js(c, `Promise.all([window.__nx.voice.watch(${JSON.stringify(ida)}), window.__nx.voice.watch(${JSON.stringify(idb)})])`);
    // C looks at the stage so we can see it in the screenshot.
    await js(c, `window.__nx.useStore.getState().selectChannel(${G}, ${V})`);
    await sleep(1500);

    const before: { framesDecoded: number; audioRecvBytes: number }[] = await Promise.all([a, b, c].map((w) => js<{ framesDecoded: number; audioRecvBytes: number }>(w, `window.__nx.voice.stats()`)));
    await sleep(5000);
    const after: { framesDecoded: number; audioRecvBytes: number }[] = await Promise.all([a, b, c].map((w) => js<{ framesDecoded: number; audioRecvBytes: number }>(w, `window.__nx.voice.stats()`)));
    const names = ["A", "B", "C"];
    after.forEach((s, i) => {
      const f = s.framesDecoded - before[i]!.framesDecoded;
      const audio = s.audioRecvBytes - before[i]!.audioRecvBytes;
      check(`${names[i]} decodes video (${i === 2 ? "2 streams" : "1 stream"})`, f > (i === 2 ? 150 : 75), `${f} frames / 5 s`);
      check(`${names[i]} receives audio`, audio > 4000, `${audio} B / 5 s`);
    });
    const tiles = await js<number>(c, `Object.values(window.__nx.useVoice.getState().watching).filter(w => w && w.hasVideo).length`);
    check("C watches 2 streams at once", tiles === 2, `${tiles}`);
    const cHearsB = await js<{ list: number; live: boolean }>(c, `(() => { const l = window.__nx.voice.debugConsumers().filter(x => x.userId === ${JSON.stringify(idb)} && x.source === "screen-audio"); return { list: l.length, live: l.every(x => x.live) }; })()`);
    check("stream audio reaches the viewer", cHearsB.list === 1 && cHearsB.live, JSON.stringify(cHearsB));

    // Theater layout: two watched streams side by side; focusing one hides the other; clicking it again goes back.
    const stageVideos = () => c.webContents.executeJavaScript(`document.querySelectorAll("main video").length`);
    const shot = async (suffix: string) => {
      if (!process.env.NX_SHOT) return;
      await c.webContents.executeJavaScript(`document.getAnimations().forEach((a) => a.finish())`);
      fs.writeFileSync(process.env.NX_SHOT.replace(/\.png$/, `-${suffix}.png`), (await c.webContents.capturePage()).toPNG());
    };
    const sideBySide = [await c.webContents.executeJavaScript(`window.__nx.useVoice.getState().focus`), await stageVideos()];
    await shot("grid");
    await c.webContents.executeJavaScript(`document.querySelectorAll("main video")[0].closest("[class*=_tile_]").click()`);
    await sleep(300);
    const focusedVideos = await stageVideos();
    await shot("focus");
    await c.webContents.executeJavaScript(`document.querySelectorAll("main video")[0].closest("[class*=_tile_]").click()`);
    await sleep(300);
    const backVideos = await stageVideos();
    check("theater: side by side -> click focuses (other hidden) -> click again side by side", sideBySide[0] === null && sideBySide[1] === 2 && focusedVideos === 1 && backVideos === 2, `${JSON.stringify(sideBySide)} ${focusedVideos} ${backVideos}`);
    // Stream tiles stay inside the stage at any window shape (wide + short, narrow + tall), side by side and focused.
    const fits = () => c.webContents.executeJavaScript(`(() => {
      const box = document.querySelector("main [class*=_theaterMain_]"); if (!box) return "no stage";
      const b = box.getBoundingClientRect();
      const bad = [...box.querySelectorAll("[class*=_tile_], video")].map((el) => el.getBoundingClientRect())
        .filter((r) => r.bottom > b.bottom + 1 || r.right > b.right + 1 || r.top < b.top - 1);
      return bad.length ? JSON.stringify({ stage: [Math.round(b.width), Math.round(b.height)], tiles: bad.map((r) => [Math.round(r.width), Math.round(r.height)]) }) : "ok";
    })()`);
    const fitResults: string[] = [];
    for (const [w, h] of [[1700, 560], [1280, 800], [900, 900]] as const) {
      c.setSize(w, h);
      await sleep(300);
      fitResults.push(`${w}x${h} grid:${await fits()}`);
      if (w === 1700) await shot("short-grid");
      await c.webContents.executeJavaScript(`window.__nx.voice.setFocus(${JSON.stringify(ida)})`);
      await sleep(200);
      fitResults.push(`${w}x${h} focus:${await fits()}`);
      if (w === 1700) await shot("short-focus");
      await c.webContents.executeJavaScript(`window.__nx.voice.setFocus(null)`);
      await sleep(200);
    }
    c.setSize(1280, 800);
    check("theater: stream tiles fit the stage at any window size", fitResults.every((x) => x.endsWith(":ok")), fitResults.join(" | "));

    // A phone held sideways (wide but short, CLAUDE.md 9.1): tabs become a rail on the left, the call
    // controls a column on the right, and the watched streams still fit what is left.
    c.setContentSize(820, 380);
    let phone = "";
    for (let i = 0; i < 25 && phone !== "ok"; i++) {
      await sleep(200);
      phone = await js<string>(c, `(() => {
        const tabs = document.querySelector("[class*=_mTabs_]"); if (!tabs) return "no tab bar " + innerWidth + "x" + innerHeight;
        if (!document.querySelector("main [class*=_theaterMain_]")) { tabs.querySelectorAll("button")[2].click(); return "opening the voice tab"; }
        const t = tabs.getBoundingClientRect(), dock = document.querySelector("[class*=_controls_]");
        if (!(t.height > t.width && t.left < 20)) return "tabs not on the side";
        if (!dock || getComputedStyle(dock).flexDirection !== "column") return "controls not in a column";
        const d = dock.getBoundingClientRect();
        return d.bottom <= innerHeight + 1 && d.right <= innerWidth + 1 ? "ok" : "controls off screen";
      })()`);
    }
    const phoneFit = phone === "ok" ? await fits() : "-";
    await shot("phone-landscape");
    c.setSize(1280, 800);
    let desktopBack = false;
    for (let i = 0; i < 25 && !desktopBack; i++) {
      await sleep(200);
      desktopBack = await js<boolean>(c, `!document.querySelector("[class*=_mTabs_]") && !!document.querySelector("main [class*=_theaterMain_]")`);
    }
    check("phone landscape: side tabs, controls column, streams fit; back to desktop", phone === "ok" && phoneFit === "ok" && desktopBack, `${phone} / fit ${phoneFit} / desktop ${desktopBack}`);

    // An unwatched stream sits in the strip with its preview; clicking it watches it again.
    await c.webContents.executeJavaScript(`window.__nx.voice.unwatch(${JSON.stringify(idb)})`);
    await sleep(800);
    const stripLive = await c.webContents.executeJavaScript(`document.querySelectorAll("main [class*=_stripThumb_]").length`);
    const oneLeft = await stageVideos();
    await c.webContents.executeJavaScript(`document.querySelector("main [class*=_stripThumb_]").closest("[class*=_stripItem_]").click()`);
    await sleep(1500);
    const rewatched = await c.webContents.executeJavaScript(`Object.keys(window.__nx.useVoice.getState().watching).length`);
    check("theater: unwatched stream shows in the strip, click watches it", stripLive === 1 && oneLeft === 1 && rewatched === 2, `${stripLive} ${oneLeft} ${rewatched}`);
    const viewers = await js<number>(a, `window.__nx.useStore.getState().guilds[${G}].voice.find(v => v.userId === ${JSON.stringify(ida)}).stream.viewers.length`);
    check("viewer count on A's stream", viewers === 2, `${viewers}`);
    const sends = await linksOf(a);
    check("A's screen goes to both viewers", sends[idb]?.screen === true && sends[idc]?.screen === true, JSON.stringify(sends));

    // Ping and connection statistics (CLAUDE.md §12.3): C is connected to A and B and watches both streams.
    type Peer = { userId: string; state: string; path: string | null; rttMs: number | null; downKbps: number | null; lossPct: number | null; videoIn: string | null };
    await js(c, `window.__nx.voice.peerStats()`);
    await sleep(1300); // rates are differences between two samples
    const peerStats = await js<Peer[]>(c, `window.__nx.voice.peerStats()`);
    const hostPing = await js<number | null>(c, `window.__nx.useStore.getState().ping`);
    const statsOk = peerStats.length === 2 && peerStats.every((p) => p.state === "connected" && !!p.path && (p.rttMs ?? 0) >= 1 && (p.downKbps ?? 0) > 0 && /\d+p\d+/.test(p.videoIn ?? ""));
    check("statistics: path, ping, bitrate and video per person; ping to the host", statsOk && typeof hostPing === "number" && hostPing >= 1 && hostPing < 5000, `host ${hostPing} ms ${JSON.stringify(peerStats)}`);
    const fromA = peerStats.find((p) => p.userId === ida)?.videoIn ?? "", fromB = peerStats.find((p) => p.userId === idb)?.videoIn ?? "";
    check("the streamer picks the codec (A: VP9, B: automatic = H.265 with a hardware encoder, else H.264)", /^VP9 /.test(fromA) && /^H26[45] /.test(fromB), `A ${fromA} | B ${fromB}`);
    const chip = await js<string | null>(c, `(() => { const b = document.querySelector("[class*=_ping_]"); if (!b) return null; b.click(); return b.textContent; })()`);
    await sleep(700);
    const panelRows = await js<number>(c, `document.querySelectorAll("[class*=_statPeer_]").length`);
    if (process.env.NX_SHOT) {
      // A hidden window's capture leaves out anything behind a backdrop filter: drop it for the picture.
      await js(c, `(() => { const d = document.querySelector("[role=dialog]"); if (d) d.parentElement.style.backdropFilter = "none"; })()`);
      await sleep(400);
    }
    await shot("stats");
    await js(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await sleep(200);
    const panelClosed = await js<number>(c, `document.querySelectorAll("[class*=_statPeer_]").length`);
    check("ping chip opens the connection panel", /\d+ ms/.test(chip ?? "") && panelRows === 2 && panelClosed === 0, `"${chip}" ${panelRows} ${panelClosed}`);

    // Speaking detection: fake mics beep; each client reports its own voice gate.
    let spoke = false;
    for (let i = 0; i < 20 && !spoke; i++) {
      spoke = await js<boolean>(c, `(window.__nx.useStore.getState().speaking[${V}] || []).length > 0`);
      if (!spoke) await sleep(250);
    }
    check("speaking detection fires", spoke);

    // Cameras: A and C turn theirs on; fake devices give a test pattern.
    for (const w of [a, c]) await js(w, `window.__nx.voice.startCamera()`);
    await sleep(2500);
    const camStates = await js<number>(b, `window.__nx.useStore.getState().guilds[${G}].voice.filter(v => v.camera).length`);
    check("camera state broadcast (A + C)", camStates === 2, `${camStates}`);
    const bSeesC = await frames(b, `window.__nx.useVoice.getState().cams[${JSON.stringify(idc)}]`);
    check("B sees C's camera", bSeesC.n > 20 && bSeesC.w > 0, JSON.stringify(bSeesC));
    const cSeesA = await frames(c, `window.__nx.useVoice.getState().cams[${JSON.stringify(ida)}]`);
    check("C sees A's camera", cSeesA.n > 20 && cSeesA.w > 0, JSON.stringify(cSeesA));

    // Noise suppression models load and run (WASM in an AudioWorklet, CSP allows it).
    const dn = await a.webContents.executeJavaScript(`(async () => {
      const out = {};
      for (const mode of ["rnnoise", "gtcrn"]) {
        try {
          const ac = new AudioContext({ sampleRate: 48000 }); const o = ac.createOscillator(); const n = ac.createGain(); n.gain.value = 0.5;
          const d = ac.createMediaStreamDestination(); o.connect(n).connect(d); o.start();
          const r = await window.__nx.denoise(d.stream.getAudioTracks()[0], mode);
          let peak = -200; const m = await window.__nx.meter(r.track, (db) => { peak = Math.max(peak, db); });
          await new Promise((res) => setTimeout(res, 1200)); m.stop(); r.stop(); o.stop(); ac.close();
          out[mode] = { ok: !!r, ran: peak > -200 };
        } catch (e) { out[mode] = { ok: false, err: String(e) }; }
      }
      return out;
    })()`);
    check("noise suppression: RNNoise and GTCRN run", dn.rnnoise?.ran === true && dn.gtcrn?.ran === true, JSON.stringify(dn));

    if (process.env.NX_SHOT) {
      const img = await c.webContents.capturePage();
      fs.writeFileSync(process.env.NX_SHOT, img.toPNG());
      log("screenshot", process.env.NX_SHOT);
    }

    // Stop + leave paths.
    await js(c, `window.__nx.voice.unwatch(${JSON.stringify(idb)})`);
    await sleep(800);
    const bSends = await linksOf(b);
    check("unwatching stops that viewer's copy of the stream", bSends[idc]?.screen === false && bSends[ida]?.screen === true, JSON.stringify(bSends));
    await js(a, `window.__nx.voice.stopScreen()`);
    await sleep(600);
    const cWatch = await js<number>(c, `Object.keys(window.__nx.useVoice.getState().watching).length`);
    check("stream stop removes it for viewers", cWatch === 0, `${cWatch}`);
    await js(c, `window.__nx.voice.stopCamera()`);
    await sleep(600);
    const camGone = await js<[boolean, number]>(b, `[!(${JSON.stringify(idc)} in window.__nx.useVoice.getState().cams), window.__nx.useStore.getState().guilds[${G}].voice.filter(v => v.camera).length]`);
    check("camera off removes it for everyone", camGone[0] === true && camGone[1] === 1, JSON.stringify(camGone));
    await js(b, `window.__nx.voice.leave()`);
    await sleep(600);
    const left = await js<number>(c, `window.__nx.useStore.getState().guilds[${G}].voice.length`);
    const cLinks = await linksOf(c);
    check("leave updates everyone and closes the connection", left === 2 && !(idb in cLinks) && Object.keys(cLinks).length === 1, `${left} ${JSON.stringify(cLinks)}`);
    // B comes back: a fresh connection to both.
    await js(b, `window.__nx.voice.join(${G}, ${V})`);
    let back: Record<string, { state: string }> = {};
    for (let i = 0; i < 40; i++) {
      back = await linksOf(b);
      if (allUp(back, 2)) break;
      await sleep(250);
    }
    check("rejoin connects again", allUp(back, 2), JSON.stringify(back));
  } catch (e) {
    check("test run", false, String((e as Error).stack ?? e));
  }
  const failed = results.filter((r) => !r[1]).length;
  log(failed ? `FAIL (${failed}/${results.length})` : `PASS (${results.length} checks)`);
  server?.kill();
  app.exit(failed ? 1 : 0);
}
