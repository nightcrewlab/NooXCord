// Faz 0 / P2: media over a plain WebSocket (what an HTTPS-only tunnel can carry).
// Sender encodes with WebCodecs (H.264 + Opus) -> binary WS frames -> server relays -> viewers decode.
// Binary frame: [kind u8 (1 video, 2 audio)] [flags u8 (bit0 key)] [serverStamp f64 ms] [timestamp f64 us] [payload]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 47830);
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
const MAX_BUFFERED = 1.5 * 1024 * 1024;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const file = path.normalize(path.join(PUB, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUB) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: false });
let sender = null;
let config = null;
const viewers = new Set();
let seq = 0;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

wss.on("connection", (ws, req) => {
  ws.nxId = ++seq;
  ws.ua = String(req.headers["user-agent"] ?? "").slice(0, 120);
  ws.needKey = true;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (ws !== sender) return;
      const buf = data;
      const kind = buf[0];
      const key = (buf[1] & 1) === 1;
      for (const v of viewers) {
        if (kind === 1) {
          if (v.needKey && !key) continue;
          if (v.bufferedAmount > MAX_BUFFERED) { v.needKey = true; v.dropped = (v.dropped ?? 0) + 1; requestKey(); continue; }
          v.needKey = false;
        } else if (v.bufferedAmount > MAX_BUFFERED * 2) continue;
        v.send(buf, { binary: true });
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    switch (msg.t) {
      case "ping":
        ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() }));
        break;
      case "hello":
        ws.role = msg.role;
        log(`#${ws.nxId} ${msg.role} joined | ${ws.ua}`);
        log(`#${ws.nxId} caps ${JSON.stringify(msg.caps)}`);
        if (msg.role === "sender") {
          sender?.close(4000, "replaced");
          sender = ws;
          for (const v of viewers) v.needKey = true;
        } else {
          viewers.add(ws);
          if (config) ws.send(JSON.stringify({ t: "config", d: config }));
          requestKey();
        }
        break;
      case "config":
        if (ws !== sender) return;
        config = msg.d;
        log(`sender config ${JSON.stringify(config)}`);
        for (const v of viewers) { v.needKey = true; v.send(JSON.stringify({ t: "config", d: config })); }
        break;
      case "stats":
        log(`#${ws.nxId} ${ws.role} stats ${JSON.stringify(msg.d)}${ws.dropped ? ` serverDropped=${ws.dropped}` : ""}`);
        break;
      case "error":
        log(`#${ws.nxId} CLIENT ERROR ${msg.d}`);
        break;
    }
  });

  ws.on("close", () => {
    log(`#${ws.nxId} ${ws.role ?? "?"} left`);
    viewers.delete(ws);
    if (ws === sender) { sender = null; config = null; for (const v of viewers) v.send(JSON.stringify({ t: "config", d: null })); }
  });
});

let lastKeyReq = 0;
function requestKey() {
  const now = Date.now();
  if (!sender || now - lastKeyReq < 500) return;
  lastKeyReq = now;
  sender.send(JSON.stringify({ t: "need-key" }));
}

server.listen(PORT, "0.0.0.0", () => log(`P2 WS media server on http://localhost:${PORT}`));
