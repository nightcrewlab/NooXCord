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

    for (const w of [a, b, c]) await w.webContents.executeJavaScript(`window.__nx.voice.join(${JSON.stringify(guildId)}, ${JSON.stringify(vc)})`);
    await sleep(1500);
    const statuses = await Promise.all([a, b, c].map((w) => w.webContents.executeJavaScript(`window.__nx.useVoice.getState().status`)));
    check("3 users connected to voice", statuses.every((s) => s === "connected"), statuses.join(","));
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
    const viewers = await a.webContents.executeJavaScript(`window.__nx.useStore.getState().guilds[${JSON.stringify(guildId)}].voice.find(v => v.userId === ${JSON.stringify(ida)}).stream.viewers.length`);
    check("viewer count on A's stream", viewers === 2, `${viewers}`);
    const videoSize = await c.webContents.executeJavaScript(`Promise.resolve([...document.querySelectorAll("video")].map(v => v.videoWidth + "x" + v.videoHeight))`);
    log("C <video> sizes", JSON.stringify(videoSize));

    // Speaking detection: fake mics beep, the server's AudioLevelObserver should flag someone.
    let spoke = false;
    for (let i = 0; i < 20 && !spoke; i++) {
      spoke = await c.webContents.executeJavaScript(`(window.__nx.useStore.getState().speaking[${JSON.stringify(vc)}] || []).length > 0`);
      if (!spoke) await sleep(250);
    }
    check("server speaking detection fires", spoke);

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
