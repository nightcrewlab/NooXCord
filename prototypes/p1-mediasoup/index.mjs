// Faz 0 / P1: does mediasoup run on this Windows machine (Node and Electron's Node)?
import * as mediasoup from "mediasoup";

const PORT = Number(process.env.PORT ?? 47821);
const t0 = performance.now();
const ok = (m) => console.log("  ✓", m);

const worker = await mediasoup.createWorker({ logLevel: "warn" });
ok(`worker pid=${worker.pid} mediasoup=${mediasoup.version} runtime=${process.versions.electron ? "electron " + process.versions.electron : "node " + process.version}`);

const router = await worker.createRouter({
  mediaCodecs: [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
    { kind: "video", mimeType: "video/H264", clockRate: 90000,
      parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 } },
    { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
  ],
});
ok(`router codecs: ${router.rtpCapabilities.codecs.map((c) => c.mimeType).join(", ")}`);

const webRtcServer = await worker.createWebRtcServer({
  listenInfos: [
    { protocol: "udp", ip: "0.0.0.0", port: PORT },
    { protocol: "tcp", ip: "0.0.0.0", port: PORT },
  ],
});
ok(`WebRtcServer listening udp+tcp :${PORT}`);

const wt = await router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true });
ok(`WebRtcTransport ICE candidates: ${wt.iceCandidates.map((c) => `${c.protocol}:${c.port}`).join(" ")}`);

const plain = await router.createPlainTransport({ listenInfo: { protocol: "udp", ip: "127.0.0.1" }, rtcpMux: true, comedia: true });
ok(`PlainTransport (WS bridge path) on 127.0.0.1:${plain.tuple.localPort}`);

const direct = await router.createDirectTransport();
ok(`DirectTransport created (in-process RTP access) id=${direct.id.slice(0, 8)}`);

const alo = await router.createAudioLevelObserver({ maxEntries: 8, threshold: -60, interval: 300 });
ok(`AudioLevelObserver ready (speaking detection) id=${alo.id.slice(0, 8)}`);

console.log(`P1 PASS in ${Math.round(performance.now() - t0)} ms`);
worker.close();
