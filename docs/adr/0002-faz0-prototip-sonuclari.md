# ADR 0002 — Faz 0 prototip sonuçları

**Tarih:** 2026-11-05 · **Test makinesi:** Windows 10 Pro 22H2 (build 19045), Node 25.9, Electron 45.2.3, Rust 1.95

| # | Prototip | Klasör | Sonuç |
|---|---|---|---|
| P1 | mediasoup Windows'ta (Node + Electron Node) | `prototypes/p1-mediasoup` | ✅ GEÇTİ |
| P2 | Ses + görüntü WebSocket üzerinden (WebCodecs) | `prototypes/p2-ws-media` | ✅ Yerelde, Cloudflare tünelinde ve iPhone Safari'de geçti (ses tamponu kayması düzeltilecek) |
| P3 | WASAPI process loopback, kendi süreç ağacını hariç tutma | `prototypes/p3-loopback` | ✅ GEÇTİ |
| P4 | Saydam, tıklama geçiren, her zaman üstte overlay | `apps/desktop/src/main/overlay.ts` | ✅ Masaüstünde ve oyunda göründü |

## P1 — mediasoup
- `npm install mediasoup` Windows x64 için **hazır derlenmiş worker** indirdi; derleme araçları gerekmedi. mediasoup 3.32.2.
- Hem Node 25 hem `ELECTRON_RUN_AS_NODE` (Electron 45) altında: Worker, Router (Opus/H.264/VP8), tek port `WebRtcServer` (UDP+TCP 47821), WebRtcTransport, PlainTransport, DirectTransport, AudioLevelObserver → hepsi ~44 ms'de hazır.
- **Sonuç:** SFU olarak mediasoup kalıyor. `mediasoup-worker.exe` paketlenirken `asarUnpack` gerekir.

## P2 — NXM-WS (tünel yedek medya yolu)
- Yayıncı: WebCodecs `VideoEncoder` (H.264 `avc1.42E02A`, annexb, realtime) + `AudioEncoder` (Opus 48 kHz mono, 20 ms çerçeve, AudioWorklet ile yakalama).
- Sunucu: ikili çerçeveleri olduğu gibi aktarır; izleyicinin tamponu dolunca ana kare olmayanları atar ve yayıncıdan yeni ana kare ister.
- İzleyici: `VideoDecoder` → canvas, `AudioDecoder` → 60 ms jitter tamponlu `AudioBufferSourceNode`.
- **Yerel sonuç (Chromium):** 720p 31 fps, ~850 kbps, ağ gecikmesi ~1 ms, ses kesintisi 0, hata 0.
- **Cloudflare Quick Tunnel üzerinden (cloudflared 2026.10.7, masaüstü Chromium izleyici):** 720p 30–31 fps, ~800–880 kbps, ağ gecikmesi ~50 ms, ses ~47 ms + 61–69 ms tampon, kesinti 0, hata 0, RTT ~95 ms. Tünel ek gecikmesi kabul edilebilir.
- Not: boş `--config` dosyası `ERR Configuration file ... was empty` logu basıyor ama tünel çalışıyor; üründe içinde yorum satırı olan bir config verilecek.
- **iPhone Safari (Safari 26.5, tünel üzerinden, 2026-11-05):** ✅ Yayın izleme çalıştı. Yetenekler: HTTPS, H.264 çözme/kodlama, Opus çözme/kodlama, AudioWorklet, getUserMedia, WebRTC **var**; getDisplayMedia **yok** (beklenen: mobil yayın açamaz).
  - İzleyici: 30–31 fps, 830–990 kbps, ağ gecikmesi 46–66 ms, ses gecikmesi 44–61 ms, hata 0.
  - **Sorun:** ses tamponu zamanla 150 ms'den 250–357 ms'ye büyüdü, dakikada birkaç kez kesinti ve geç paket görüldü. Sebebi saat kayması ve `AudioBufferSourceNode` ile basit zamanlama. **Üründe yapılacak:** AudioWorklet halka tamponu, hedef 60–80 ms, hafif hız ayarı (±%0.5) ile kaymayı düzeltme, 120 ms üstünde paket atma.
  - iPhone'dan mikrofon gönderme: `NotAllowedError` aldı (izin/jest bağlamı). Üründe `AudioContext` oluşturma ve `getUserMedia` çağrısı **dokunma olayının içinde, hiçbir `await`'ten önce** yapılacak. Telefondan mikrofon gönderimi Faz 3'te yeniden doğrulanacak.
- **Android Chrome:** test edilmedi. Chromium tabanlı olduğu için masaüstü sonuçlarına yakın olması bekleniyor; Faz 3'te doğrulanacak.

## P3 — Yayın sesinden kendi sesimizi çıkarma
- `wasapi` 0.26 crate'i, `AudioClient::new_application_loopback_client(pid, include_tree)`.
- Test: kendi süreç (1000 Hz), alt süreç (1500 Hz), ağaç dışı süreç (2000 Hz, WMI ile başlatıldı).

| Yakalama | 1000 Hz (kendi) | 1500 Hz (alt süreç) | 2000 Hz (dışarıdaki) |
|---|---|---|---|
| INCLUDE kendi ağacı | 0.394 | 0.394 | 0.0001 |
| EXCLUDE kendi ağacı | **0.0001** | **0.0001** | 0.392 |

- **Sonuç:** Windows 10 2004+ üzerinde yöntem çalışıyor ve **alt süreçleri de** hariç tutuyor. Electron sesi ayrı bir alt süreçte (audio service) çaldığı için bu kritik. Ana süreç PID'i hedef alınacak. `packages/native` bu crate ile napi-rs modülü olarak yazılacak.

## P4 — Overlay
- `transparent + frame:false + focusable:false + setAlwaysOnTop('screen-saver') + setIgnoreMouseEvents(true)` ile masaüstünde sol üstte göründü. Konuşan için yeşil çerçeve, susan için soluk görünüm ve "YAYINDA" rozeti doğru çalışıyor.
- **Oyun testi (2026-11-07, NooXRii):** ✅ Overlay oyunun üstünde göründü (`Ctrl+Shift+O`). Özel (exclusive) tam ekran modu ayrıca test edilmedi; o mod için plan değişmedi (Faz 5, deneysel).
