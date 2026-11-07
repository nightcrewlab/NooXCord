"use strict";
// Faz 0 / P2 client: sender (WebCodecs encode) and viewer (WebCodecs decode) over one WebSocket.
const $ = (id) => document.getElementById(id);
const HDR = 18; // kind u8, flags u8, serverStamp f64, timestamp f64

let ws = null;
let role = null;
let clockOffset = 0; // serverNow = Date.now() + clockOffset
let bestRtt = Infinity;
const rttSamples = [];
const serverNow = () => Date.now() + clockOffset;

// ---------- capabilities ----------
async function detectCaps() {
  const caps = { secure: window.isSecureContext };
  const tryCfg = async (Cls, cfg) => { try { return !!(Cls && (await Cls.isConfigSupported(cfg)).supported); } catch { return false; } };
  caps.videoDecodeH264 = await tryCfg(window.VideoDecoder, { codec: "avc1.42E01F" });
  caps.videoEncodeH264 = await tryCfg(window.VideoEncoder, { codec: "avc1.42E01F", width: 1280, height: 720 });
  caps.audioDecodeOpus = await tryCfg(window.AudioDecoder, { codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
  caps.audioEncodeOpus = await tryCfg(window.AudioEncoder, { codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
  caps.audioWorklet = typeof AudioWorkletNode !== "undefined";
  caps.getUserMedia = !!navigator.mediaDevices?.getUserMedia;
  caps.getDisplayMedia = !!navigator.mediaDevices?.getDisplayMedia;
  caps.webrtc = typeof RTCPeerConnection !== "undefined";
  return caps;
}
const CAP_LABELS = {
  secure: "Güvenli bağlam (HTTPS)", videoDecodeH264: "H.264 çözme (yayın izleme)", videoEncodeH264: "H.264 kodlama",
  audioDecodeOpus: "Opus çözme (ses dinleme)", audioEncodeOpus: "Opus kodlama (mikrofon gönderme)", audioWorklet: "AudioWorklet",
  getUserMedia: "Mikrofon erişimi API", getDisplayMedia: "Ekran paylaşımı API", webrtc: "WebRTC",
};
let caps = {};
detectCaps().then((c) => {
  caps = c;
  $("caps").innerHTML = Object.entries(c).map(([k, v]) => `<tr><td>${CAP_LABELS[k] ?? k}</td><td class="${v ? "y" : "n"}">${v ? "VAR" : "YOK"}</td></tr>`).join("");
});

// ---------- socket ----------
function connect(r) {
  role = r;
  return new Promise((resolve, reject) => {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "hello", role: r, caps }));
      ping();
      setInterval(ping, 2000);
      resolve();
    };
    ws.onerror = () => reject(new Error("WebSocket hatası"));
    ws.onclose = (e) => setStatus(`Bağlantı kapandı (${e.code})`);
    ws.onmessage = (e) => (typeof e.data === "string" ? onControl(JSON.parse(e.data)) : onBinary(e.data));
  });
}
function ping() { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "ping", c: Date.now() })); }
function onControl(m) {
  if (m.t === "pong") {
    const now = Date.now();
    const rtt = now - m.c;
    rttSamples.push(rtt); if (rttSamples.length > 10) rttSamples.shift();
    if (rtt <= bestRtt * 1.2 || rttSamples.length < 3) { bestRtt = Math.min(bestRtt, rtt); clockOffset = m.s - (m.c + rtt / 2); }
  } else if (m.t === "need-key") forceKey = true;
  else if (m.t === "config") viewerConfigure(m.d);
}
const sendCtl = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
window.addEventListener("error", (e) => sendCtl({ t: "error", d: String(e.message) }));
window.addEventListener("unhandledrejection", (e) => sendCtl({ t: "error", d: String(e.reason) }));

function packet(kind, key, timestamp, byteLength, copy) {
  const buf = new ArrayBuffer(HDR + byteLength);
  const dv = new DataView(buf);
  dv.setUint8(0, kind); dv.setUint8(1, key ? 1 : 0);
  dv.setFloat64(2, serverNow()); dv.setFloat64(10, timestamp);
  copy(new Uint8Array(buf, HDR));
  return buf;
}

// ---------- SENDER ----------
let forceKey = true;
const sstats = { vFrames: 0, vBytes: 0, aBytes: 0, vDropped: 0, encoder: "" };

$("btnSend").onclick = () => { $("sendOpts").classList.remove("hidden"); };
$("btnStart").onclick = async () => {
  $("btnStart").disabled = true; $("btnView").disabled = true;
  try {
    await connect("sender");
    const [w, h] = $("res").value.split("x").map(Number);
    const fps = Number($("fps").value);
    const cfg = {};
    if ($("vsrc").value !== "none") cfg.video = await startVideo($("vsrc").value, w, h, fps);
    if ($("asrc").value !== "none") cfg.audio = await startAudio($("asrc").value);
    sendCtl({ t: "config", d: cfg });
    setInterval(() => {
      const s = { ...sstats, kbps: Math.round(((sstats.vBytes + sstats.aBytes) * 8) / 1000) };
      setStatus(`YAYINCI · ${sstats.encoder}\nvideo ${s.vFrames} fps · ${s.kbps} kbps · düşen ${s.vDropped} · ws tampon ${Math.round(ws.bufferedAmount / 1024)} KB`);
      sendCtl({ t: "stats", d: s });
      sstats.vFrames = 0; sstats.vBytes = 0; sstats.aBytes = 0;
    }, 1000);
  } catch (e) { setStatus("Hata: " + e.message); sendCtl({ t: "error", d: e.message }); }
};

async function startVideo(src, w, h, fps) {
  const cv = $("cv");
  let frameSource;
  if (src === "screen") {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: w, height: h, frameRate: fps }, audio: false });
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.srcObject = stream; await v.play();
    frameSource = v;
  } else {
    frameSource = document.createElement("canvas");
    frameSource.width = w; frameSource.height = h;
  }
  const candidates = ["avc1.42E02A", "avc1.4D002A", "avc1.64002A", "avc1.42E01F"];
  const bitrate = Math.min(8_000_000, Math.round(w * h * fps * 0.08));
  let config = null;
  for (const codec of candidates) {
    const c = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: "realtime", avc: { format: "annexb" } };
    if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; }
  }
  if (!config) throw new Error("H.264 kodlayıcı yok");
  sstats.encoder = `${config.codec} ${w}x${h}@${fps} ${(bitrate / 1e6).toFixed(1)} Mbps`;

  const enc = new VideoEncoder({
    output: (chunk) => {
      const pkt = packet(1, chunk.type === "key", chunk.timestamp, chunk.byteLength, (dst) => chunk.copyTo(dst));
      sstats.vBytes += pkt.byteLength; sstats.vFrames++;
      ws.send(pkt);
    },
    error: (e) => sendCtl({ t: "error", d: "VideoEncoder " + e.message }),
  });
  enc.configure(config);

  const ctx2 = cv.getContext("2d");
  let n = 0;
  const t0 = performance.now();
  setInterval(() => {
    if (src === "test") drawPattern(frameSource, n, fps);
    if (src === "screen" && frameSource.readyState < 2) return;
    if (enc.encodeQueueSize > 2 || ws.bufferedAmount > 2_000_000) { sstats.vDropped++; return; }
    const ts = Math.round((performance.now() - t0) * 1000);
    const frame = new VideoFrame(frameSource, { timestamp: ts });
    const key = forceKey || n % (fps * 2) === 0;
    forceKey = false;
    enc.encode(frame, { keyFrame: key });
    if (n % 2 === 0) ctx2.drawImage(frameSource, 0, 0, cv.width, cv.height); // local preview
    frame.close();
    n++;
  }, 1000 / fps);
  return { codec: config.codec, width: w, height: h, fps };
}

function drawPattern(c, n, fps) {
  const g = c.getContext("2d");
  const { width: W, height: H } = c;
  const sec = Math.floor(serverNow() / 1000);
  const flash = serverNow() % 1000 < 100;
  g.fillStyle = flash ? "#ff7a45" : "#11141a"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#3ddc84"; g.fillRect(((n * 8) % (W + 200)) - 200, H * 0.62, 200, H * 0.12);
  g.fillStyle = "#e8ecf2"; g.font = `bold ${Math.round(H / 9)}px Segoe UI, sans-serif`; g.textAlign = "center";
  g.fillText(new Date(serverNow()).toISOString().slice(11, 23), W / 2, H * 0.4);
  g.font = `${Math.round(H / 22)}px Segoe UI, sans-serif`; g.fillStyle = "#9aa3b2";
  g.fillText(`NooXCord P2 · kare ${n} · ${fps} fps · saniye ${sec % 60}`, W / 2, H * 0.52);
}

async function startAudio(src) {
  const ac = new AudioContext({ sampleRate: 48000 });
  await ac.audioWorklet.addModule("capture-worklet.js");
  let input;
  if (src === "mic") {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    input = ac.createMediaStreamSource(stream);
  } else {
    // 880 Hz beep for 100 ms at the start of every server second (lines up with the video flash)
    const osc = ac.createOscillator(); osc.frequency.value = 880;
    const gain = ac.createGain(); gain.gain.value = 0;
    osc.connect(gain); osc.start();
    setInterval(() => { gain.gain.value = serverNow() % 1000 < 100 ? 0.4 : 0; }, 10);
    input = gain;
  }
  const node = new AudioWorkletNode(ac, "nx-capture");
  const sink = ac.createGain(); sink.gain.value = 0;
  input.connect(node); node.connect(sink); sink.connect(ac.destination);

  const config = { codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 48000 };
  if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error("Opus kodlayıcı yok");
  const enc = new AudioEncoder({
    output: (chunk) => {
      const pkt = packet(2, true, chunk.timestamp, chunk.byteLength, (dst) => chunk.copyTo(dst));
      sstats.aBytes += pkt.byteLength;
      ws.send(pkt);
    },
    error: (e) => sendCtl({ t: "error", d: "AudioEncoder " + e.message }),
  });
  enc.configure(config);
  const FRAME = 960; // 20 ms
  let acc = new Float32Array(FRAME), fill = 0, samples = 0;
  node.port.onmessage = (e) => {
    const block = e.data;
    let i = 0;
    while (i < block.length) {
      const take = Math.min(FRAME - fill, block.length - i);
      acc.set(block.subarray(i, i + take), fill); fill += take; i += take;
      if (fill === FRAME) {
        enc.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: Math.round((samples / 48000) * 1e6), data: acc }));
        samples += FRAME; acc = new Float32Array(FRAME); fill = 0;
      }
    }
  };
  return { codec: "opus", sampleRate: 48000, channels: 1 };
}

// ---------- VIEWER ----------
let vdec = null, adec = null, ac = null, nextPlay = 0, waitKey = true;
const vstats = { frames: 0, bytes: 0, lat: [], aLat: [], underruns: 0, late: 0, errors: 0 };

$("btnView").onclick = async () => {
  $("btnView").disabled = true; $("btnSend").disabled = true;
  ac = new AudioContext({ sampleRate: 48000 });
  // iOS unlock: play one silent buffer inside the tap handler
  const sb = ac.createBufferSource(); sb.buffer = ac.createBuffer(1, 1, 48000); sb.connect(ac.destination); sb.start();
  await ac.resume();
  try { await connect("viewer"); } catch (e) { setStatus("Hata: " + e.message); return; }
  setStatus("Yayıncı bekleniyor…");
  setInterval(viewerTick, 1000);
};

function viewerConfigure(cfg) {
  try { vdec?.close(); } catch {} try { adec?.close(); } catch {}
  vdec = adec = null; waitKey = true;
  if (!cfg) { setStatus("Yayın yok — yayıncı bekleniyor…"); return; }
  if (cfg.video) {
    const cv = $("cv"); const g = cv.getContext("2d");
    vdec = new VideoDecoder({
      output: (frame) => {
        if (cv.width !== frame.displayWidth) { cv.width = frame.displayWidth; cv.height = frame.displayHeight; }
        g.drawImage(frame, 0, 0); frame.close(); vstats.frames++;
      },
      error: (e) => { vstats.errors++; sendCtl({ t: "error", d: "VideoDecoder " + e.message }); waitKey = true; viewerConfigure(cfg); },
    });
    vdec.configure({ codec: cfg.video.codec, codedWidth: cfg.video.width, codedHeight: cfg.video.height, optimizeForLatency: true });
  }
  if (cfg.audio && window.AudioDecoder) {
    adec = new AudioDecoder({ output: playAudio, error: (e) => { vstats.errors++; sendCtl({ t: "error", d: "AudioDecoder " + e.message }); } });
    adec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
  }
}

function onBinary(buf) {
  if (role !== "viewer") return;
  const dv = new DataView(buf);
  const kind = dv.getUint8(0), key = (dv.getUint8(1) & 1) === 1;
  const stamp = dv.getFloat64(2), ts = dv.getFloat64(10);
  const data = new Uint8Array(buf, HDR);
  vstats.bytes += buf.byteLength;
  const lat = serverNow() - stamp;
  if (kind === 1 && vdec?.state === "configured") {
    if (waitKey && !key) return;
    waitKey = false;
    if (vdec.decodeQueueSize > 8) { vstats.late++; waitKey = true; return; }
    vstats.lat.push(lat);
    vdec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts, data }));
  } else if (kind === 2 && adec?.state === "configured") {
    vstats.aLat.push(lat);
    adec.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data }));
  }
}

function playAudio(ad) {
  const n = ad.numberOfFrames;
  const pcm = new Float32Array(n);
  try {
    if (String(ad.format).includes("planar")) ad.copyTo(pcm, { planeIndex: 0 });
    else { const all = new Float32Array(n * ad.numberOfChannels); ad.copyTo(all, { planeIndex: 0 }); for (let i = 0; i < n; i++) pcm[i] = all[i * ad.numberOfChannels]; }
  } catch (e) { sendCtl({ t: "error", d: "AudioData.copyTo " + e.message + " fmt=" + ad.format }); ad.close(); return; }
  const rate = ad.sampleRate; ad.close();
  const b = ac.createBuffer(1, n, rate); b.copyToChannel(pcm, 0);
  const s = ac.createBufferSource(); s.buffer = b; s.connect(ac.destination);
  const now = ac.currentTime;
  if (nextPlay < now + 0.01) { if (nextPlay) vstats.underruns++; nextPlay = now + 0.06; }
  else if (nextPlay > now + 0.35) { vstats.late++; nextPlay = now + 0.06; }
  s.start(nextPlay); nextPlay += n / rate;
}

const med = (a) => (a.length ? Math.round([...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]) : "-");
let tick = 0;
function viewerTick() {
  const buffered = ac ? Math.max(0, Math.round((nextPlay - ac.currentTime) * 1000)) : 0;
  const s = { fps: vstats.frames, kbps: Math.round((vstats.bytes * 8) / 1000), videoLatMs: med(vstats.lat), audioLatMs: med(vstats.aLat), audioBufMs: buffered, underruns: vstats.underruns, late: vstats.late, errors: vstats.errors, rtt: med(rttSamples) };
  setStatus(`İZLEYİCİ\nvideo ${s.fps} fps · ${s.kbps} kbps · gecikme ${s.videoLatMs} ms (ağ, kod çözme hariç)\nses gecikme ${s.audioLatMs} ms + tampon ${s.audioBufMs} ms · kesinti ${s.underruns} · geç ${s.late}\nrtt ${s.rtt} ms · hata ${s.errors}`);
  if (++tick % 3 === 0) sendCtl({ t: "stats", d: s });
  vstats.frames = 0; vstats.bytes = 0; vstats.lat = []; vstats.aLat = [];
}

function setStatus(t) { $("stats").textContent = t; }
