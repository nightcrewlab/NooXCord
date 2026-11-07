import fs from "node:fs";
import { app, BrowserWindow } from "electron";
import * as localHost from "./localHost";

/*
 * Faz 2 "done" check, headless: three users (separate in-memory sessions) join one voice channel,
 * two of them stream, everybody watches every other stream. Media is real WebRTC through the host's
 * mediasoup; microphones are Chromium fake devices, screens are animated canvases.
 *   NX_SELFTEST=voice NX_UITEST_HOST=http://127.0.0.1:47840 [NX_SHOT=out.png] electron apps/desktop
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
const shareCanvas = (win: BrowserWindow, color: string) =>
  win.webContents.executeJavaScript(`(async () => {
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
    const g = c.getContext("2d"); let f = 0;
    setInterval(() => { f++; g.fillStyle = ${JSON.stringify(color)}; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = "#fff"; g.font = "bold 96px sans-serif"; g.fillText("NooXCord test " + f, 80 + (f * 7) % 400, 380); }, 33);
    const track = c.captureStream(30).getVideoTracks()[0];
    await window.__nx.voice.startScreen({ preset: "low", contentHint: "motion", audio: false, testTrack: track });
    return window.__nx.useVoice.getState().sharing;
  })()`);

export async function voiceSelfTest(): Promise<void> {
  // Without NX_UITEST_HOST the test starts the app's own host (utilityProcess + mediasoup worker).
  let host = process.env.NX_UITEST_HOST;
  if (!host) {
    const st = await localHost.start(Number(process.env.NX_SELFTEST_PORT ?? 47850));
    if (!st.running) { log("✗ local host", st.error); return app.exit(1); }
    host = `http://127.0.0.1:${st.port}`;
    log("using in-app host", host);
  }
  const results: [string, boolean, string?][] = [];
  const check = (name: string, ok: boolean, info?: string) => {
    results.push([name, ok, info]);
    log(ok ? "✓" : "✗", name, info ?? "");
  };
  try {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [a, b, c] = (await Promise.all(["Ayse", "Mert", "Zeynep"].map((n) => openUser(host, `${n}_${suffix}`)))) as [BrowserWindow, BrowserWindow, BrowserWindow];
    const gs = await call(a, "guild.create", { name: "Ses Testi" });
    const guildId = gs.guild.id as string;
    const vc = gs.channels.find((x: { kind: string }) => x.kind === "voice").id as string;
    const inv = await call(a, "invite.create", { guildId });
    await call(b, "invite.join", { code: inv.code });
    await call(c, "invite.join", { code: inv.code });
    const ids: string[] = await Promise.all([a, b, c].map((w) => w.webContents.executeJavaScript(`window.__nx.useStore.getState().me.id`)));
    const [ida, idb] = ids as [string, string, string];

    // C uses tunnel mode (NXM-WS: WebSocket + WebCodecs), A and B use WebRTC.
    await c.webContents.executeJavaScript(`window.__nx.voice.forceWs = true`);
    for (const w of [a, b, c]) await w.webContents.executeJavaScript(`window.__nx.voice.join(${JSON.stringify(guildId)}, ${JSON.stringify(vc)})`);
    await sleep(1500);
    const statuses = await Promise.all([a, b, c].map((w) => w.webContents.executeJavaScript(`window.__nx.useVoice.getState().status`)));
    check("3 users connected to voice", statuses.every((s) => s === "connected"), statuses.join(","));
    const modes = await Promise.all([a, b, c].map((w) => w.webContents.executeJavaScript(`window.__nx.useVoice.getState().transport`)));
    check("C is in tunnel mode, A/B WebRTC", modes.join() === "rtc,rtc,ws", modes.join(","));
    const seen = await c.webContents.executeJavaScript(`window.__nx.useStore.getState().guilds[${JSON.stringify(guildId)}].voice.length`);
    check("voice states broadcast to members", seen === 3, `C sees ${seen}`);

    const sa = await shareCanvas(a, "#7a2e12");
    const sb = await shareCanvas(b, "#123a7a");
    check("A and B started streams", !!sa && !!sb, `${JSON.stringify(sa)} ${JSON.stringify(sb)}`);
    await sleep(1200);
    const thumbs = await c.webContents.executeJavaScript(`window.__nx.useStore.getState().guilds[${JSON.stringify(guildId)}].voice.filter(v => v.stream).map(v => !!v.stream.thumbnail)`);
    check("two streams listed with one-off thumbnails", thumbs.length === 2 && thumbs.every(Boolean), JSON.stringify(thumbs));

    await a.webContents.executeJavaScript(`window.__nx.voice.watch(${JSON.stringify(idb)})`);
    await b.webContents.executeJavaScript(`window.__nx.voice.watch(${JSON.stringify(ida)})`);
    await c.webContents.executeJavaScript(`Promise.all([window.__nx.voice.watch(${JSON.stringify(ida)}), window.__nx.voice.watch(${JSON.stringify(idb)})])`);
    // C looks at the stage so we can see it in the screenshot.
    await c.webContents.executeJavaScript(`window.__nx.useStore.getState().selectChannel(${JSON.stringify(guildId)}, ${JSON.stringify(vc)})`);

    const before: { framesDecoded: number; audioRecvBytes: number }[] = await Promise.all([a, b, c].map((w) => w.webContents.executeJavaScript(`window.__nx.voice.stats()`)));
    await sleep(5000);
    const after = await Promise.all([a, b, c].map((w) => w.webContents.executeJavaScript(`window.__nx.voice.stats()`)));
    const names = ["A", "B", "C"];
    after.forEach((s, i) => {
      const frames = s.framesDecoded - before[i]!.framesDecoded;
      const audio = s.audioRecvBytes - before[i]!.audioRecvBytes;
      check(`${names[i]} decodes video (${i === 2 ? "2 streams" : "1 stream"})`, frames > (i === 2 ? 150 : 75), `${frames} frames / 5 s`);
      check(`${names[i]} receives voice audio`, audio > 4000, `${audio} B / 5 s`);
    });
    const tiles = await c.webContents.executeJavaScript(`Object.values(window.__nx.useVoice.getState().watching).filter(w => w && w.hasVideo).length`);
    check("C watches 2 streams at once", tiles === 2, `${tiles}`);

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
    // An unwatched stream sits in the strip with its preview; clicking it watches it again.
    await c.webContents.executeJavaScript(`window.__nx.voice.unwatch(${JSON.stringify(idb)})`);
    await sleep(800);
    const stripLive = await c.webContents.executeJavaScript(`document.querySelectorAll("main [class*=_stripThumb_]").length`);
    const oneLeft = await stageVideos();
    await c.webContents.executeJavaScript(`document.querySelector("main [class*=_stripThumb_]").closest("[class*=_stripItem_]").click()`);
    await sleep(1500);
    const rewatched = await c.webContents.executeJavaScript(`Object.keys(window.__nx.useVoice.getState().watching).length`);
    check("theater: unwatched stream shows in the strip, click watches it", stripLive === 1 && oneLeft === 1 && rewatched === 2, `${stripLive} ${oneLeft} ${rewatched}`);
    const viewers = await a.webContents.executeJavaScript(`window.__nx.useStore.getState().guilds[${JSON.stringify(guildId)}].voice.find(v => v.userId === ${JSON.stringify(ida)}).stream.viewers.length`);
    check("viewer count on A's stream", viewers === 2, `${viewers}`);
    const videoSize = await c.webContents.executeJavaScript(`Promise.resolve([...document.querySelectorAll("video")].map(v => v.videoWidth + "x" + v.videoHeight))`);
    log("C <video> sizes", JSON.stringify(videoSize));

    // Streamer's tunnel quality choice: C (tunnel) gets A's small layer by default, the full one on "high".
    const cWidthOfA = () => c.webContents.executeJavaScript(`(async () => {
      const w = window.__nx.useVoice.getState().watching[${JSON.stringify(ida)}]; if (!w) return -1;
      const v = document.createElement("video"); v.muted = true; v.srcObject = w.stream; await v.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 400)); const n = v.videoWidth; v.srcObject = null; return n;
    })()`);
    const lowW = await cWidthOfA();
    await a.webContents.executeJavaScript(`window.__nx.voice.setTunnelQuality(true)`);
    await sleep(2500);
    const highW = await cWidthOfA();
    check("streamer picks tunnel quality (low -> high layer)", lowW > 0 && highW > lowW, `${lowW} -> ${highW}`);
    await a.webContents.executeJavaScript(`window.__nx.voice.setTunnelQuality(false)`);

    // Speaking detection: fake mics beep, the server's AudioLevelObserver should flag someone.
    let spoke = false;
    for (let i = 0; i < 20 && !spoke; i++) {
      spoke = await c.webContents.executeJavaScript(`(window.__nx.useStore.getState().speaking[${JSON.stringify(vc)}] || []).length > 0`);
      if (!spoke) await sleep(250);
    }
    check("server speaking detection fires", spoke);

    // Cameras: A over WebRTC, C over the tunnel path (WebCodecs H.264 -> WS -> host RTP). Fake devices give a test pattern.
    for (const w of [a, c]) await w.webContents.executeJavaScript(`window.__nx.voice.startCamera()`);
    await sleep(2500);
    const camStates = await b.webContents.executeJavaScript(`window.__nx.useStore.getState().guilds[${JSON.stringify(guildId)}].voice.filter(v => v.camera).length`);
    check("camera state broadcast (A + C)", camStates === 2, `${camStates}`);
    const camFrames = (w: BrowserWindow, uid: string) => w.webContents.executeJavaScript(`(async () => {
      const s = window.__nx.useVoice.getState().cams[${JSON.stringify(uid)}]; if (!s) return { n: -1, w: 0, h: 0 };
      const v = document.createElement("video"); v.muted = true; v.srcObject = s; await v.play().catch(() => {});
      document.body.appendChild(v); v.style.cssText = "position:fixed;left:0;top:0;width:160px;height:120px";
      await new Promise((r) => setTimeout(r, 500));
      const q0 = v.getVideoPlaybackQuality().totalVideoFrames, t0 = v.currentTime;
      await new Promise((r) => setTimeout(r, 2500));
      const n = v.getVideoPlaybackQuality().totalVideoFrames - q0, dt = v.currentTime - t0;
      v.remove(); return { n, dt: Math.round(dt * 10) / 10, w: v.videoWidth, h: v.videoHeight };
    })()`);
    const idc = ids[2]!;
    const bSeesC = await camFrames(b, idc);
    check("WebRTC user sees the tunnel user's camera", bSeesC.n > 20 && bSeesC.w > 0, JSON.stringify(bSeesC));
    const cSeesA = await camFrames(c, ida);
    check("tunnel user sees a WebRTC camera", cSeesA.n > 20 && cSeesA.w > 0, JSON.stringify(cSeesA));
    const bSeesA = await camFrames(b, ida);
    check("WebRTC user sees a WebRTC camera", bSeesA.n > 20 && bSeesA.w > 0, JSON.stringify(bSeesA));

    // Screen share from the tunnel user (WebCodecs H.264 next to the camera encoder), watched over WebRTC.
    const sc = await shareCanvas(c, "#2e7a12");
    check("tunnel user starts a screen share", !!sc, JSON.stringify(sc));
    await b.webContents.executeJavaScript(`window.__nx.voice.watch(${JSON.stringify(idc)})`);
    await sleep(1500);
    const bSeesCScreen = await b.webContents.executeJavaScript(`(async () => {
      const w = window.__nx.useVoice.getState().watching[${JSON.stringify(idc)}]; if (!w || !w.stream) return { n: -1, w: 0, h: 0 };
      const v = document.createElement("video"); v.muted = true; v.srcObject = w.stream; await v.play().catch(() => {});
      document.body.appendChild(v); v.style.cssText = "position:fixed;left:0;top:0;width:160px;height:90px";
      await new Promise((r) => setTimeout(r, 500));
      const q0 = v.getVideoPlaybackQuality().totalVideoFrames;
      await new Promise((r) => setTimeout(r, 2500));
      const n = v.getVideoPlaybackQuality().totalVideoFrames - q0;
      v.remove(); return { n, w: v.videoWidth, h: v.videoHeight };
    })()`);
    check("WebRTC user watches the tunnel user's screen", bSeesCScreen.n > 15 && bSeesCScreen.w > 0, JSON.stringify(bSeesCScreen));
    await c.webContents.executeJavaScript(`window.__nx.voice.stopScreen()`);
    await sleep(400);

    if (process.env.NX_SHOT) {
      const img = await c.webContents.capturePage();
      fs.writeFileSync(process.env.NX_SHOT, img.toPNG());
      log("screenshot", process.env.NX_SHOT);
    }

    // Stop + leave paths.
    await a.webContents.executeJavaScript(`window.__nx.voice.stopScreen()`);
    await sleep(600);
    const cWatch = await c.webContents.executeJavaScript(`Object.keys(window.__nx.useVoice.getState().watching).length`);
    check("stream stop removes it for viewers", cWatch === 1, `${cWatch}`);
    await c.webContents.executeJavaScript(`window.__nx.voice.stopCamera()`);
    await sleep(600);
    const camGone = await b.webContents.executeJavaScript(`[!(${JSON.stringify(idc)} in window.__nx.useVoice.getState().cams), window.__nx.useStore.getState().guilds[${JSON.stringify(guildId)}].voice.filter(v => v.camera).length]`);
    check("camera off removes it for everyone", camGone[0] === true && camGone[1] === 1, JSON.stringify(camGone));
    await b.webContents.executeJavaScript(`window.__nx.voice.leave()`);
    await sleep(600);
    const left = await c.webContents.executeJavaScript(`window.__nx.useStore.getState().guilds[${JSON.stringify(guildId)}].voice.length`);
    check("leave updates everyone", left === 2, `${left}`);
  } catch (e) {
    check("test run", false, String((e as Error).stack ?? e));
  }
  const failed = results.filter((r) => !r[1]).length;
  log(failed ? `FAIL (${failed}/${results.length})` : `PASS (${results.length} checks)`);
  if (!process.env.NX_UITEST_HOST) await localHost.stop();
  app.exit(failed ? 1 : 0);
}
