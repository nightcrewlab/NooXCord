# NooXCord — CLAUDE.md

> **Geliştirici:** NooXRii · **Platform:** Windows 10 (2004 / build 19041+) ve Windows 11 masaüstü + mobil/masaüstü web tarayıcı istemcisi
> **Tür:** Kendi sunucunu barındırdığın, Discord benzeri sesli/görüntülü sohbet ve ekran paylaşımı uygulaması
> **Durum:** Faz 5 (paketleme) — `pnpm dist` ile `NooXCord-Setup-0.5.1.exe` (140 MB) üretiliyor, paketlenmiş uygulama kendi testlerini geçti (2026-11-07). Repo + auto-update: `github.com/nightcrewlab/NooXCord` (§17.18). Kalan: temiz Windows 10 VM'de kurulum testi (kullanıcıda), imza sertifikası. Prototip sonuçları `docs/adr/0002-faz0-prototip-sonuclari.md`. Bu dosya projenin tek doğruluk kaynağıdır; bir karar değişirse önce burası güncellenir. Mimari kararlar `docs/adr/` altında.

---

## 0. Claude için çalışma kuralları

- Kullanıcıyla **Türkçe** konuş. Kod, değişken adları, commit mesajları ve kod yorumları **İngilizce**.
- Arayüz metinleri hiçbir zaman koda gömülmez; `packages/client/src/i18n/tr.json` ve `en.json` üzerinden gelir (varsayılan dil: Türkçe).
- **Emoji veya hazır ikon kütüphanesi (lucide, heroicons, material vb.) KULLANMA.** Bütün ikonlar `packages/icons` içinde elle çizilmiş SVG olarak bulunur (bkz. §9).
- Yeni bir bağımlılık eklemeden önce: lisansı (MIT/Apache/BSD tercih edilir; GPL **yasak**), boyutu ve Windows'ta native derleme gerektirip gerektirmediğini kontrol et. Native ise prebuilt binary'si olmalı.
- Her özellik bir faz (§13) altında yapılır; faz sırasını atlama. Bir fazı bitirmeden önce o fazın "Bitti tanımı" maddelerini doğrula.
- Kullanıcıya sormadan: commit atma, push etme, tunnel açma, firewall kuralı ekleme, servis başlatma/durdurma.
- Platforma özel kod (Windows API, native modül) her zaman bir **adapter arayüzünün** arkasında durur; istemci kodu `window.nx` (preload köprüsü) yoksa web modunda çalışmaya devam etmelidir.

---

## 1. Ürün özeti

NooXCord; bir kullanıcının kendi PC'sinde **Host** (sunucu) çalıştırdığı, diğerlerinin masaüstü uygulamasıyla veya tarayıcıdan bağlandığı bir sohbet uygulamasıdır. Merkezi bir bulut sunucusu **yoktur**.

### Temel özellikler
| Alan | Özellik |
|---|---|
| Sunucu (Guild) | Sunucu oluşturma, ikon/isim, davet bağlantısı, rol ve yetkiler |
| Metin kanalları | Mesaj, link (önizlemeli), resim/video/dosya paylaşımı, düzenleme/silme, yanıtlama, yazıyor göstergesi, okunmamış sayacı, bahsetme (@) |
| Sesli kanallar | Bas-konuş veya ses aktivasyonu, sustur/sağırlaştır, kişi başı ses seviyesi, gürültü bastırma, konuşan göstergesi, **kamera** (masaüstü + telefon dahil, tünel modunda da) |
| Ekran yayını | Çözünürlük + FPS seçimi, birden fazla monitör / tek pencere seçimi, sistem sesi (**NooXCord'un kendi sesi hariç**), aynı anda birden fazla yayıncı, aynı anda birden fazla yayın izleme, tek seferlik thumbnail önizleme |
| Uzaktan kontrol | İzleyici yayıncının klavye/faresini kontrol edebilir — yalnızca yayıncı izin verirse |
| Overlay | Oyun üstü overlay: sesli kanaldaki kişiler (kendin dahil), konuşan yeşil çerçeve, "YAYINDA" rozeti |
| Hesaplar | Masaüstü: nickname + e-posta + şifre, kalıcı oturum. Web/mobil: yalnızca nickname (misafir) |
| Ağ | LAN, Hamachi, **Cloudflare Quick Tunnel** (varsayılan, hesapsız, URL kopyala/QR), Microsoft Dev Tunnels (isteğe bağlı, sabit URL), manuel port + port müsaitlik kontrolü |
| Dağıtım | Tek `NooXCord-Setup-x.y.z.exe`; kurulduğunda ek bir şey kurmaya gerek kalmadan çalışır |

---

## 2. Mimari kararı

### 2.1 Seçilen yığın
| Katman | Teknoloji | Neden |
|---|---|---|
| Masaüstü kabuğu | **Electron** (güncel kararlı sürüm) + `electron-builder` (NSIS) | WebRTC, `desktopCapturer`, çoklu monitör, şeffaf overlay penceresi, global kısayollar ve native modül desteği tek pakette. Tauri/WebView2'de ekran yakalama ve overlay kontrolü yetersiz. |
| Dil | **TypeScript (strict)** her yerde; native kısım **Rust + napi-rs** | Tip güvenliği; Rust ile güvenli Windows API erişimi ve prebuilt `.node` dosyaları |
| UI | **React 19 + Vite**, **Zustand** (state), **CSS Modules + CSS değişkenleri** (tasarım token'ları), `@tanstack/react-virtual` (mesaj listesi) | Hafif, hızlı; aynı istemci hem Electron'da hem tarayıcıda çalışır |
| Host sunucusu | **Node.js (Electron `utilityProcess` içinde)**: **Fastify** (HTTP/REST + statik web istemcisi), **ws** (gerçek zamanlı protokol), **zod** (şema doğrulama) | Ana süreçten ayrı süreçte çalışır, UI donmaz |
| Medya (SFU) | **mediasoup** (v3) + `mediasoup-client` (ilk sese katılmada yüklenir) | Ses ve yayınları tek seferde herkese dağıtır, simulcast, ICE-TCP desteği. Kanal başına bir router, tek `WebRtcServer` (ana port + 1, UDP+TCP, tüm LAN/Hamachi IPv4 adreslerinde) |
| Veritabanı | **SQLite**, Node'un yerleşik **`node:sqlite`** modülü (WAL) + `packages/server/src/db.ts` içinde numaralı SQL migration'ları | Native modül yok → Electron için yeniden derleme yok. Electron 45 = Node 24, yerleşik geliyor |
| Şifreleme | Node yerleşik **`scrypt`** (N=2¹⁵, r=8, p=1) şifre hash'i; Electron `safeStorage` (DPAPI) ile istemci token saklama | Native modül gerektirmez |
| Medya işleme | Avatar / sunucu simgesi **istemcide** canvas ile 256px kare WebP'ye çevrilir; sunucu magic-byte ile tür doğrular. RNNoise (WASM) Faz 2 | `sharp` gerekmedi |
| Native modül | `packages/native` (Rust/napi-rs): WASAPI process-loopback, SendInput, pencere/monitör listeleme, Hamachi adaptör tespiti | |
| Tünel | `TunnelProvider` arayüzü: **`cloudflared`** (varsayılan, Apache-2.0, installer'a gömülü) + **`devtunnel`** CLI (isteğe bağlı) — alt süreç olarak yönetilir | ADR 0001 |
| Test | **Vitest** (birim), **Playwright** (web + Electron e2e) | |
| Paket yöneticisi | **pnpm workspaces** | |

### 2.2 Süreç modeli (masaüstü)
```
┌──────────────────────────── NooXCord.exe ────────────────────────────┐
│ Main process (Electron)                                              │
│  • pencere/tray/kısayol/overlay yönetimi                             │
│  • tunnel & hamachi yöneticisi, port kontrolü, auto-update           │
│  • native modül çağrıları (input injection, loopback audio)          │
│      │ IPC (typed, allowlist)                                        │
│      ├── Renderer: Ana pencere (React istemci)                       │
│      ├── Renderer: Overlay penceresi (şeffaf, click-through)         │
│      └── utilityProcess: HOST SERVER (sadece "Sunucu barındır" açıkken)│
│              ├── Fastify + ws  (REST, sinyal, sohbet)                │
│              ├── SQLite                                              │
│              └── mediasoup-worker.exe (alt süreç, C++)               │
└──────────────────────────────────────────────────────────────────────┘
          ▲ LAN / Hamachi (25.x.x.x) / Dev Tunnel (https)
          │
   Diğer masaüstü istemcileri  ·  Tarayıcı (PC / iPhone / Android)
```
- Her masaüstü uygulaması **istemci**dir; isteğe bağlı olarak **host** da olabilir.
- Bir istemci birden fazla host'a bağlanabilir (sol kenar çubuğundaki sunucu listesi = bağlantı listesi). Bir host birden fazla guild barındırabilir.
- Host, derlenmiş web istemcisini (`packages/client` build çıktısı) aynı porttan sunar → tarayıcıdan giren kişi ek kurulum yapmaz.

### 2.3 Medya taşıma stratejisi (KRİTİK — önce bunu doğrula)
Cloudflare Quick Tunnel ve Dev Tunnels **yalnızca HTTP(S)/WebSocket** trafiğini tarayıcıya iletir; **UDP ve ham TCP (TURN/ICE-TCP) tünelden geçmez.** Bu yüzden medya katmanlı çalışır, istemci sırayla dener:

1. **WebRTC / UDP doğrudan** — LAN, Hamachi veya UPnP/manuel açılmış UDP portu (`mediasoup WebRtcServer`, tek UDP+TCP port, varsayılan `ana port + 1`).
2. **WebRTC / ICE-TCP** — aynı portun TCP'si dışarı açıksa.
3. **NXM-over-WebSocket (tunnel yedeği)** — tünel üzerinden `wss://.../media`:
   - Ses: Opus paketleri (mediasoup `PlainTransport`/`DirectTransport` → WS köprüsü), istemcide WebCodecs `AudioDecoder` + AudioWorklet jitter buffer.
   - Video: H.264 (Annex-B) parçaları → istemcide WebCodecs `VideoDecoder` → `<canvas>`.
   - Gönderim (mikrofon): WebCodecs `AudioEncoder` (Opus). Desteklemeyen tarayıcıda yalnızca dinleme moduna düş ve kullanıcıya bildir.
   - Gecikme hedefi < 400 ms; bu mod ayarlar ekranında "Tünel modu (yüksek gecikme)" olarak gösterilir.

**Faz 0 sonucu (ADR 0002):** 3. yol Cloudflare tüneli üzerinden iPhone Safari'de çalıştı (30 fps, ~55 ms ağ gecikmesi). Zorunlu kurallar:
- Ses oynatma AudioWorklet halka tamponu ile yapılır (hedef 60–80 ms, ±%0.5 hız ayarıyla saat kayması düzeltilir); `AudioBufferSourceNode` zamanlaması kullanılmaz (iPhone'da tampon 350 ms'ye kaydı).
- iOS'ta `AudioContext` ve `getUserMedia` dokunma olayının içinde, ilk `await`'ten önce başlatılır.

### 2.4 Bant genişliği gerçeği
SFU host'un PC'sinde çalıştığı için **her izleyici host'un upload'undan beslenir.** Ayarlarda tahmini toplam upload göster (izleyici sayısı × bitrate) ve limit aşılınca uyar. Simulcast (3 katman) ile zayıf bağlantılara düşük katman gönder.

---

## 3. Klasör yapısı (monorepo)

```
NooXCord/
├─ CLAUDE.md
├─ package.json / pnpm-workspace.yaml / tsconfig.base.json
├─ apps/
│  └─ desktop/                 # Electron
│     ├─ src/main/             # main process: windows, tray, ipc, overlay, tunnel, hamachi, updater, ports
│     ├─ src/preload/          # contextBridge → window.nx (typed)
│     ├─ src/host/             # utilityProcess giriş noktası → packages/server'ı başlatır
│     ├─ resources/            # icon.ico, tray ikonları, devtunnel indirme betiği
│     └─ electron-builder.yml
├─ packages/
│  ├─ client/                  # React istemci (Electron renderer + web), responsive
│  │  ├─ src/app/              # rotalar, layout (desktop / mobile)
│  │  ├─ src/features/         # auth, guilds, channels, chat, voice, stream, remote, overlay, settings
│  │  ├─ src/media/            # mediasoup-client, NXM-WS taşıma, VAD, RNNoise
│  │  ├─ src/platform/         # DesktopPlatform | WebPlatform adapter'ları
│  │  ├─ src/styles/           # tokens.css, temalar
│  │  └─ src/i18n/
│  ├─ server/                  # Host: Fastify, ws, mediasoup, db, auth, uploads, link unfurl
│  ├─ shared/                  # protokol tipleri, sabitler, izin bitleri; zod şemaları ayrı: "@nooxcord/shared/schemas" (yalnızca sunucu import eder → istemci paketine zod girmez)
│  ├─ native/                  # Rust napi-rs: loopback audio, input, monitors, net adapters
│  └─ icons/                   # Elle çizilmiş SVG ikonlar: kaynak src/icons.ts, svg/*.svg ve sheet.svg `pnpm icons` ile üretilir
├─ prototypes/                 # Faz 0 doğrulama prototipleri (ürün koduna import edilmez)
├─ assets/brand/               # logo.svg, icon kaynakları
├─ docs/adr/                   # mimari karar kayıtları (ADR)
└─ scripts/                    # build, icon üretimi, release
```

---

## 4. Komutlar

Paket yöneticisi **pnpm 9** (`node-linker=hoisted`, Electron/native modüller için). Electron binary'si inmediyse: `node node_modules/electron/install.js`.

```bash
pnpm install
pnpm dev            # Electron + Vite HMR (uygulama içinden "Bu bilgisayarda barındır" ile host başlar)
pnpm dev:host       # yalnızca host sunucusu (tsx watch) → http://localhost:47820 (web istemcisini de sunar; önce client build)
pnpm dev:web        # yalnızca web istemcisi (Vite :5173, VITE_NX_HOST ile host seçilir; varsayılan localhost:47820)
pnpm typecheck      # tüm paketler
pnpm test           # host uçtan uca (22) + uzaktan kontrol & DM kuralları (12) + yedekleme (4) + link önizleme SSRF / resim proxy
pnpm build          # client (vite) + desktop main/preload/host (esbuild)
pnpm brand          # assets/brand/*.svg → icon.ico, favicon, PWA ikonları
pnpm icons          # ikon tablosu → packages/icons/svg/*.svg + sheet.svg
```

Masaüstü kendi kendine testleri (pencere göstermeden, geçici userData ile):
```bash
NX_SELFTEST=1 electron apps/desktop        # host utilityProcess, safeStorage, port çakışması
NX_SELFTEST=ui NX_UITEST_HOST=http://127.0.0.1:47820 NX_SHOT=shot.png electron apps/desktop   # arayüz + file:// → host HTTP/WS
# Faz 2-3: 3 kullanıcı, 2 yayın, herkes izliyor; C tünel modunda (NXM-WS). Uygulamanın kendi host'u (47850) ile
pnpm test:voice        # = NX_SELFTEST=voice electron apps/desktop  (21 kontrol, kamera dahil; NX_UITEST_HOST=... ile dış host, NX_SHOT=... ekran görüntüsü)
# UI testi giriş yapıp bir betik çalıştırabilir: NX_UITEST_TOKEN=<token> NX_UITEST_JS="<js>" (ör. ayarlar sayfasını açmak)
```
Native modül (Rust, `packages/native`): `pnpm build:native` → `nooxcord-native.win32-x64.node` (loopback ses, bas-konuş tuş durumu, özel tam ekran tespiti).
Geliştirmede `cloudflared.exe` `.tools/` altında (gitignore); paketlenmiş uygulamada `resources/bin/`. `devtunnel.exe` ilk kullanımda `%LOCALAPPDATA%/NooXCord/bin/`'e indirilir ve Microsoft imzası doğrulanır.

Faz 0 prototipleri:
```bash
node prototypes/p1-mediasoup/index.mjs                 # mediasoup testi
node prototypes/p2-ws-media/server.mjs                 # WS medya testi → http://localhost:47830
cargo run --release --manifest-path prototypes/p3-loopback/Cargo.toml   # loopback hariç tutma testi
```
Overlay testi: `pnpm dev` açıkken `Ctrl+Shift+O`.

Kurulum paketi (Faz 5):
```bash
pnpm dist           # build + scripts/dist.mjs → release/NooXCord-Setup-<sürüm>.exe (sürüm: apps/desktop/package.json)
pnpm dist:dir       # yalnızca release/win-unpacked (kurulum yok, hızlı deneme)
NX_SELFTEST=voice release/win-unpacked/NooXCord.exe   # paketlenmiş uygulamada ses/yayın testi
```
`scripts/dist.mjs`: `release/app` klasörünü hazırlar (esbuild çıktıları + yalnızca dış bırakılan modüller: `electron-updater`, `mediasoup` (lib + worker exe), `@nooxcord/native` (index.js + .node)), sonra `apps/desktop/electron-builder.yml` ile NSIS üretir. Gerekenler: `.tools/cloudflared.exe`, `pnpm build:native` çıktısı, Visual Studio'nun VC++ x64 runtime DLL'leri (en yenisi otomatik bulunur; yoksa `.tools/vcruntime/`).

Sonradan eklenecekler: `pnpm lint`, `pnpm test:e2e` (playwright).

---

## 5. Kimlik ve hesaplar

### 5.1 Masaüstü kullanıcı (kayıtlı hesap)
- Kayıt: **nickname + e-posta + şifre** (şifre min. 8 karakter). Hesap **o host'un** veritabanında tutulur (şifre `scrypt` ile hash'lenir).
- Giriş başarılı olunca host **opak oturum token'ı** (32 bayt rastgele) verir; veritabanında yalnızca SHA-256 hash'i tutulur. Süre 90 gün, kullanıldıkça uzar (günde bir), çıkışta silinir. Masaüstünde token **Electron `safeStorage`** ile şifrelenip `%APPDATA%/NooXCord/hosts.json`'da (host URL'si başına) saklanır; web'de `localStorage`'da → her açılışta tekrar giriş istemez. (Access + refresh ayrımı yerel host için gereksiz bulundu.)
- Giriş: e-posta **veya** kullanıcı adı + şifre. 5 hatalı deneme → 5 dk kilit; IP başına 20 istek/dk.
- Bir istemci aynı anda **tek host'a** bağlı (raydaki logo menüsünden "Sunucu değiştir"); kayıtlı host listesi tutulur. Aynı anda birden fazla host: ileriki faz.
- Profil resmi: yükle → istemcide ortadan kare kırpılıp 256px WebP'ye çevrilir → host magic-byte ile doğrular (≤ 2 MB). Hareketli GIF avatar: Faz 4 (opsiyonel).
- Nickname benzersiz (büyük/küçük harf duyarsız), 2–32 karakter.

### 5.2 Web / mobil kullanıcı (misafir)
- Giriş ekranı yok; yalnızca **nickname** girilir.
- Nickname daha önce **bir misafir** tarafından kullanıldıysa → aynı misafir kimliği sayılır (geçmiş mesajlar, ayarlar ona bağlanır). Tarayıcıda bir cihaz token'ı (`localStorage`) da tutulur.
- Nickname **kayıtlı bir hesaba** aitse → reddedilir ("Bu isim kayıtlı bir kullanıcıya ait"). Misafir hiçbir zaman kayıtlı kullanıcının yerine geçemez.
- Misafir kısıtları: uzaktan kontrol **yok** (ne alabilir ne verebilir), ekran yayını açamaz (mobilde zaten yok; masaüstü tarayıcı misafiri için de Faz 1'de kapalı), sunucu yönetemez. **Kamera açabilir** (`VIDEO` izni misafir varsayılanında). Host bu kısıtları rol ayarlarından genişletebilir (uzaktan kontrol hariç — o sabit kapalı).
- Misafir oturumları için host ayarı: "Misafir girişine izin ver" (varsayılan açık) ve opsiyonel **sunucu davet şifresi** (tünel herkese açık olduğu için önerilir).

### 5.3 Roller ve izinler
`Owner`, `Admin`, `Member`, `Guest` + özel roller. İzinler bit maskesi (`packages/shared/permissions.ts`): kanal görme, mesaj gönderme, dosya yükleme, sese katılma, konuşma, yayın açma, kamera açma (`VIDEO`, migration 3 ile mevcut varsayılan rollere eklendi), uzaktan kontrol isteme, kanal yönetme, üye atma/yasaklama.

---

## 6. Ekran yayını

### 6.1 Kaynak seçimi
- `desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize })` → **her monitör ayrı kart** (monitör adı + çözünürlük, native modülden `EnumDisplayMonitors` ile zenginleştirilir) ve pencereler.
- Renderer'da `session.setDisplayMediaRequestHandler` ile seçilen kaynak verilir.

### 6.2 Kalite ayarları
| Ön ayar | Çözünürlük | FPS |
|---|---|---|
| Düşük | 720p | 30 |
| Standart | 1080p | 30 |
| Akıcı | 1080p | 60 |
| Yüksek | 1440p | 60 |
| Kaynak | Monitör çözünürlüğü | 30 / 60 / 120 (monitör destekliyorsa) |
- Ek: "Akıcılık / Netlik" tercihi (`contentHint: 'motion' | 'detail'`), maksimum bitrate kaydırıcısı.
- Codec: H.264 (donanım kodlayıcı, Windows Media Foundation) öncelikli — NXM-WS yolu ve iOS ile uyumlu. VP9/AV1 yalnızca tüm izleyiciler destekliyorsa.

### 6.3 Yayın sesi — kendi sesimizi hariç tutma
Amaç: yayına sistem sesi gider ama **NooXCord'un çaldığı sesler (diğer kişilerin sesi) gitmez**, böylece izleyiciler kendilerini duymaz.
1. **Birincil (P3'te doğrulandı ✅, alt süreçleri de hariç tutuyor):** `packages/native` içinde (`wasapi` crate) WASAPI **Process Loopback** (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` + `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, hedef PID = NooXCord ana süreci → tüm alt süreç ağacı hariç). Windows 10 2004+.
   PCM → paylaşılan bellek/MessagePort → renderer'da AudioWorklet → `MediaStreamTrackGenerator` / `MediaStreamDestination` → yayın ses track'i.
2. **Alternatif (dene):** Chromium `getDisplayMedia` `restrictOwnAudio` / `systemAudio: 'include'` kısıtı; Electron sürümünde çalışıyorsa native yola gerek kalmaz. Hangisinin kullanıldığı loglanır.
3. Pencere paylaşımında: yalnızca o pencerenin süreç ağacının sesi (`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`).
4. Hiçbiri yoksa: yayın sessiz başlar ve kullanıcı uyarılır. **Asla** NooXCord sesini içeren düz loopback kullanılmaz.

### 6.5 Kamera
- Sesli kanalda **kamera** düğmesi (masaüstü, tarayıcı, telefon). Kaynak `camera` (video), izin `P.VIDEO`; misafirler dahil herkes açabilir. Durum `VoiceState.camera` ile yayılır, kenar çubuğunda kamera simgesi.
- Ekran yayınının aksine kameralar kanaldaki **herkese otomatik** gönderilir (ses gibi; "İzle" gerekmez). Katılımcı kartı videoya dönüşür, tıklayınca büyür; kendi görüntün aynalanır.
- WebRTC: 640×480 hedef, 24 fps, tek katman, maks. 600 kbps, H.264 öncelikli.
- **Tünel modu (telefon + Cloudflare):** tarayıcı WebCodecs `VideoEncoder` ile H.264 constrained baseline (`avc1.42e01f`, Annex-B; yoksa avcC → Annex-B dönüşümü) kodlar, kareler `<video>` → canvas üzerinden alınır (iPhone Safari'de de çalışır), 20 fps, ≤640 px, 450 kbps. WS çerçevesi `[4][key][ts90k][AU]` → host RTP'ye paketler (tek NAL / FU-A, `rtp.ts` `packetizeH264`) → DirectTransport producer. İzleyicilerden gelen PLI/FIR → `[5]` çerçevesi → tarayıcı anahtar kare üretir; ayrıca 3 sn'de bir anahtar kare.
- Telefonda birden fazla kamera varsa **ön/arka çevir** düğmesi (producer kalır, `replaceTrack`). Masaüstünde kamera seçimi Ayarlar → Ses.

### 6.4 Çoklu yayın ve izleme
- Aynı sesli kanalda birden fazla kişi aynı anda yayın açabilir.
- Yayın başladığında yayıncı **tek bir kare** yakalar (JPEG, 480px genişlik) ve host'a gönderir → kanal görünümünde **tek seferlik thumbnail** kartı (canlı güncellenmez; trafik tasarrufu). Kartta: yayıncı adı, kalite rozeti, izleyici sayısı, **"Yayını İzle"** butonu.
- "Yayını İzle"ye basılmadan video consumer **oluşturulmaz** (bant genişliği).
- Birden fazla yayın aynı anda izlenebilir: ızgara görünümü, odak (büyük) görünümü, her yayın için ayrı ses seviyesi, tam ekran, ayrı pencereye çıkar (pop-out, masaüstü).
- İzlenmeyen yayınlar için mediasoup consumer'ları `pause` edilir; görünmeyen (scroll dışı) ızgara hücrelerinde düşük simulcast katmanına geçilir.

---

## 7. Uzaktan kontrol (Remote Control)

### 7.1 Akış
- İzleyici yayın üzerinde **"Kontrol İste"** → yayıncıda bildirim: *Kabul / Reddet / Her zaman bu kişiye izin ver (oturum boyunca)*.
- Veya yayıncı izleyici listesinde bir kişiye **sağ tık → "Kontrolü Ver"** (doğrudan).
- Aynı anda **yalnızca bir** kontrolcü. Yayıncı istediği an geri alır.

### 7.2 Teknik
- Girdi olayları ana WebSocket üzerinden host'a gider (`{t:"rc"}` çerçevesi, yanıtsız, kendi hız sınırı 120/sn) ve host yalnızca **o anki kontrolcüden** gelenleri yayıncıya iletir (Faz 4 kararı: DataChannel yerine WS — her iki medya modunda aynı yol, host her olayı doğrular). Koordinatlar **normalize** (0–1) gönderilir, yayıncı tarafında yayınlanan monitörün fiziksel piksel sınırlarına eşlenir (`screen.dipToScreenRect`, çoklu monitör + DPI).
- Yayıncı tarafında `packages/native` → Win32 **`SendInput`** (fare hareketi/tık/tekerlek, klavye VK + scan code). Enjekte edilen olaylar `dwExtraInfo` etiketi taşır; düşük seviyeli kancalar (WH_KEYBOARD_LL / WH_MOUSE_LL) etiketsiz = fiziksel girdiyi algılar. Kod: `apps/desktop/src/main/remote.ts`, `packages/native/src/input.rs`, `packages/client/src/media/remote.ts`.
- Pencere paylaşımında girdi yalnızca o pencerenin sınırları içinde kabul edilir.

### 7.3 Güvenlik kuralları (pazarlık konusu değil)
- Misafirler (web/mobil) kontrol **isteyemez**; mobil istemcide buton hiç gösterilmez. Sunucu tarafında da reddedilir.
- Kontrol aktifken yayıncının ekranında sürekli görünür bir çerçeve/rozet: "X şu an kontrol ediyor".
- **Panik kısayolu:** `Ctrl+Alt+Shift+Esc` (değiştirilebilir) → kontrolü anında keser. Ayrıca yayıncı herhangi bir fiziksel girdi yaptığında 2 sn öncelik yayıncıdadır.
- Engellenen kombinasyonlar: `Ctrl+Alt+Del` (zaten mümkün değil), `Win+L`, ayar ile ek kombinasyonlar.
- Yönetici (UAC) yetkili pencerelere girdi gönderilemez (Windows UIPI) — bu bilinen sınırlama UI'da açıklanır; uygulama yönetici olarak çalıştırılmaz.
- Hareketsizlik zaman aşımı (varsayılan 10 dk) ve tüm kontrol oturumları host'ta loglanır.

---

## 8. Oyun içi overlay

- Ayrı `BrowserWindow`: `transparent`, `frame:false`, `focusable:false`, `skipTaskbar`, `setAlwaysOnTop(true, 'screen-saver')`, `setIgnoreMouseEvents(true, { forward: true })`, `setVisibleOnAllWorkspaces`.
- İçerik: bulunulan sesli kanaldaki herkes (**kendin dahil**), avatar + isim.
  - Konuşan: avatar çerçevesi **yeşil yanar** (`--nx-speaking`), isim tam opak ve kalın.
  - Konuşmayan: %45 opaklık, soluk.
  - Yayındaysa isim yanında **"YAYINDA"** rozeti (kırmızı nokta + metin).
  - Susturulmuş/sağırlaştırılmış ikonları.
- Konuşan tespiti: her istemci kendi ses kapısını (VAD / bas-konuş; mikrofonun ses gönderip göndermediğini belirleyen kapı) `voice.speaking` ile bildirir, host kanaldaki herkese yayar. Kendi halkan yerel olarak anında yanar. (mediasoup `AudioLevelObserver` Faz 2 testinde sessiz paketleri ortalamaya kattığı için kısa konuşmaları kaçırdı → kaldırıldı.)
- Ayarlar: aç/kapat, konum (4 köşe), boyut, opaklık, "yalnızca konuşanları göster", kısayol (`Shift+\``) ile kilit açıp sürükleme.
- **Tam ekran oyunlar:** Kenarlıksız tam ekran (borderless) ve pencereli modda yukarıdaki yöntem çalışır. **Özel (exclusive) tam ekran** DirectX/Vulkan hook (DLL enjeksiyonu) gerektirir; bu anti-cheat sistemleri (Vanguard, EAC, BattlEye) tarafından ban sebebi olabilir.
  - Faz 3: borderless/pencereli destek + exclusive fullscreen tespit edildiğinde kullanıcıya "oyunu kenarlıksız moda alın" ipucu.
  - Faz 5 (opsiyonel, deneysel): oyun bazında açık rıza ile `packages/native` içinde DXGI Present hook. Anti-cheat listesi olan oyunlarda varsayılan kapalı. GPL kod (ör. OBS graphics-hook) **kopyalanmaz**.
- Overlay penceresi gizliyken render durdurulur (CPU/GPU tasarrufu); yalnızca sesli kanalda iken oluşturulur.

---

## 9. Tasarım sistemi

### 9.1 Kimlik
Özgün, koyu ve modern; Discord'un düzenini kopyalamaz.
- **Düzen:** Solda dar "host/sunucu rayı" (yuvarlatılmış kare ikonlar) → kanal paneli → içerik. Sesli kanal paneli içerikte **sahne (stage)** gibi açılır: üstte yayın thumbnail'ları, altta katılımcı kartları. Sağda açılır/kapanır üye paneli.
- **Mobil (< 768px):** alt sekme çubuğu (Sunucular / Sohbet / Ses / Profil), kaydırarak açılan çekmeceler, büyük dokunma hedefleri (min. 44px), sesli kanal için tam ekran "çağrı" görünümü.

### 9.2 Renk token'ları (`packages/client/src/styles/tokens.css`)
```css
--nx-bg-0: #0B0D11;      /* en arka plan */
--nx-bg-1: #11141A;      /* paneller */
--nx-bg-2: #171B23;      /* kartlar, input */
--nx-bg-3: #1F2430;      /* hover */
--nx-line: #262C38;
--nx-text-1: #E8ECF2;
--nx-text-2: #9AA3B2;
--nx-text-3: #5F6878;
--nx-accent: #FF7A45;    /* "Nova" turuncu — marka rengi */
--nx-accent-2: #FFB347;  /* gradyan ikinci durak */
--nx-speaking: #3DDC84;  /* konuşan yeşil */
--nx-live: #FF3B5C;      /* YAYINDA */
--nx-warn: #F5C451;
--nx-radius-s: 6px; --nx-radius-m: 10px; --nx-radius-l: 16px;
```
- Yazı tipi: **Inter** (gövde) + **Space Grotesk** (başlık/marka) — yerel olarak paketlenir, CDN kullanılmaz.
- Hareket: 120–180 ms, `cubic-bezier(.2,.8,.2,1)`; `prefers-reduced-motion` desteklenir.

### 9.3 İkonlar
- Kaynak `packages/icons/src/icons.ts` (ikon adı → iç SVG işaretlemesi) — **24×24 grid, 1.75px stroke, yuvarlak uç/köşe, `currentColor`**. Hepsi aynı stilde elle çizilir; yeni ikon eklerken `pnpm icons` ile `sheet.svg` üretip mevcutlarla yan yana kontrol et.
- Kullanım: `<Icon name="mic-off" size={20} label="…" />` (label yoksa `aria-hidden`). Faz 1'de 62 ikon var.
- Gerekli set (başlangıç): mic, mic-off, headphones, headphones-off, screen-share, screen-stop, monitor, window, eye (izle), hand (kontrol iste), mouse-keyboard, phone-hangup, settings, plus, hash (metin kanalı), speaker (sesli kanal), link, paperclip, image, file, send, reply, edit, trash, pin, bell, bell-off, user, users, crown, shield, tunnel, globe, lan, copy, refresh, check, close, chevron-*, more, search, live-dot, overlay, volume, signal.

### 9.4 Uygulama ikonu / logo
- **Konsept:** yuvarlatılmış kare (squircle) koyu grafit zemin (`#11141A`), üzerinde turuncu→amber gradyanla (`#FF7A45 → #FFB347`) çizilmiş, iki ses dalgası yayının kesişmesinden oluşan stilize bir **"X"**; kesişim noktasında küçük bir nokta (konuşma/bağlantı düğümü). "NooX" kimliğini ve sesi birlikte anlatır.
- Kaynak: `assets/brand/logo.svg`. `scripts/build-icons` → `icon.ico` (16, 24, 32, 48, 64, 128, 256), tray ikonları (normal / susturulmuş / yayında varyantları), web `favicon.svg`, PWA ikonları (192/512, maskable).
- 16px'de okunur kalmalı: küçük boyutlarda dalgalar sadeleştirilmiş özel bir 16px çizimi kullanılır.

---

## 10. Ağ: LAN, Hamachi, Dev Tunnel, port

Tümü **Ayarlar → Bağlantı** sayfasından yönetilir. Her öğenin durumu canlı gösterilir (kapalı / başlatılıyor / aktif / hata + log).

### 10.1 Port
- Kullanıcı ana portu elle girer (varsayılan **47820**; medya için `port+1` UDP/TCP).
- **"Kontrol Et"** ve yazarken (debounce 400 ms) otomatik kontrol: ana süreçte `net.createServer().listen()` (TCP) ve `dgram.bind()` (UDP) denemesi, hem `0.0.0.0` hem `127.0.0.1` üzerinde → sonuç: ✓ Müsait / ✗ Kullanımda (mümkünse kullanan süreç adı, `GetExtendedTcpTable` ile) / ✗ Yetki gerekiyor (<1024).
- "Boş port öner" butonu.
- Port değişince host yeniden başlatılır, aktif tünelin portu güncellenir.

### 10.2 Windows Güvenlik Duvarı
- Kurulum yönetici istemediği için kural kurulumda eklenmez (Faz 5 kararı). **Ayarlar → Bağlantı → Windows Güvenlik Duvarı → İzin ver**: UAC onayıyla `netsh` iki kural ekler (`NooXCord.exe` + `mediasoup-worker.exe`, yalnızca Özel profil, ad `NooXCord`, öncekiler silinir). Durum `Get-NetFirewallRule` ile gösterilir. Herkese açık profil desteklenmez. Windows ilk dinlemede kendi izin penceresini de gösterebilir.

### 10.3 Hamachi
- LogMeIn Hamachi'nin Windows için resmi CLI'si **yoktur**; bu yüzden NooXCord Hamachi'yi kurmaz/yönetmez, **algılar ve kullanır**:
  - Hamachi ağ adaptörü (`Hamachi` adlı arayüz, 25.x.x.x IPv4) native modül/`os.networkInterfaces()` ile tespit edilir.
  - Ayar anahtarı: **"Hamachi üzerinden yayınla"** → host o arayüzde de dinler ve davet bağlantısında Hamachi IP'si gösterilir.
  - "Hamachi servisini başlat/durdur" butonu: `Hamachi2Svc` servisi için yönetici yetkili yardımcı (UAC onayı ile, `sc start/stop`).
  - Kurulu değilse: resmi indirme sayfasına bağlantı.
- Hamachi'de medya UDP doğrudan çalışır (§2.3 yol 1).

### 10.4 Tünel sağlayıcıları (ADR 0001)
Ortak `TunnelProvider` arayüzü: `start(port) → url`, `stop()`, `status`, `onUrlChange`. Ayarlarda sağlayıcı seçilir, tek anahtarla açılıp kapatılır. Ortak UI: **"URL'yi kopyala"** butonu (üst çubukta da), global kısayol `Ctrl+Shift+L` (değiştirilebilir), QR kod ve URL değişince masaüstü bildirimi.

#### Cloudflare Quick Tunnel (varsayılan)
- `cloudflared.exe` (Apache-2.0) installer ile `resources/bin/` altına gömülür. Hesap veya giriş **gerekmez**.
- Başlat: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` → stderr'den `https://<rastgele>.trycloudflare.com` URL'si parse edilir.
- URL **her başlatmada değişir**; bu bilinçli bir tercih (kullanıcı sabit URL'yi şart koşmadı). Yeni URL otomatik panoya kopyalanabilir (ayar).
- Tarayıcıda uyarı/ara sayfa çıkmaz. SSE desteklenmez → gerçek zamanlı her şey WebSocket'ten gider. Boşta kalan WS'ler kapatılır → 2 sn ping zorunlu.
- 200 eşzamanlı istek sınırı vardır; HTTP isteklerini azaltmak için her istemci tek bir WS bağlantısı üzerinden çoğullanır.
- `~/.cloudflared/config.yml` varsa quick tunnel çalışmaz → uygulama `--config` ile boş bir yapılandırma dosyası verir.
- Süreç çökerse artan aralıklarla yeniden başlatılır ve yeni URL bildirilir.

#### Microsoft Dev Tunnels (isteğe bağlı — sabit URL isteyenler için)
- **CLI temini:** `devtunnel.exe` Microsoft'un resmi adresinden (`https://aka.ms/TunnelsCliDownload/win-x64`) **ilk kullanımda indirilir** ve `%LOCALAPPDATA%/NooXCord/bin/` altına konur (yeniden dağıtım lisansı belirsiz olduğu için installer'a gömülmez; indirme imza/hash ile doğrulanır). Kurulum sırasında indirme seçeneği de sunulur.
- **GitHub girişi (bir kez):** `devtunnel user login -g -d` (device code). Kod ve URL uygulama içinde gösterilir, tarayıcı açılır. Token'ı CLI kendisi saklar; durum `devtunnel user show` ile kontrol edilir. "Çıkış yap" butonu.
- **Sabit URL:** İlk oluşturmada tünel ID'si üretilir ve saklanır (`nooxcord-<rastgele6>`):
  ```bash
  devtunnel create <id> --allow-anonymous      # public
  devtunnel port create <id> -p <port> --protocol http
  devtunnel host <id>
  ```
  URL biçimi: `https://<id>-<port>.<bölge>.devtunnels.ms` — aynı ID kullanıldığı sürece değişmez.
- **"Yeni URL oluştur":** onay sonrası eski tünel `devtunnel delete <id>` ile silinir, yeni ID ile oluşturulur (eski bağlantılar geçersiz olur — UI uyarır).
- **Aç/kapat:** anahtar `devtunnel host` alt sürecini başlatır/durdurur; çıktı parse edilerek durum ve URL gösterilir; çökme olursa artan aralıklarla yeniden dener.
- Kalıcı tüneller uzun süre kullanılmazsa **süresi dolar** (Microsoft varsayılanı ~30 gün) → uygulama açılışında `devtunnel show` ile kontrol edilir, süresi dolmuşsa aynı ID ile yeniden oluşturmayı dener.
- Anonim erişimde tarayıcı ilk girişte Microsoft'un **uyarı sayfasını** gösterir; istemcinin API/WS isteklerine `X-Tunnel-Skip-AntiPhishing-Page: true` başlığı eklenir. Kullanıcıya bu sayfa hakkında bilgi gösterilir.
- Dev Tunnels'ın **kullanım/bant genişliği limitleri** vardır; yayın trafiği bunları hızla tüketebilir → ayarlarda uyarı ve tünel modunda varsayılan yayın kalitesi "Düşük".
- Paylaş butonu: URL'yi kopyala + **QR kod** (telefondan hızlı giriş için).

### 10.5 HTTPS gerekliliği
Tarayıcılar mikrofon/ses için **güvenli bağlam (HTTPS)** ister. Dev Tunnel zaten HTTPS. LAN'dan **tarayıcı** ile giriş için host isteğe bağlı self-signed sertifika üretir (uyarı kabul edilmeli); masaüstü istemci için bu gerekmez.

### 10.6 Davet bağlantısı
`nooxcord://join?h=<host>&p=<port>&code=<davet>` (protokol işleyici kayıtlı) + tünel için düz HTTPS URL. Davet kodları süre/kullanım limitli.

---

## 11. Web / mobil istemci

- Aynı `packages/client`, `WebPlatform` adapter'ı ile. Masaüstüne özgü özellikler (overlay, uzaktan kontrol, yayın açma, global kısayol, tray) web'de gizlenir.
- iOS Safari: ses çalmak ve mikrofon için kullanıcı dokunuşu gerekir → "Sese Katıl" butonu `AudioContext.resume()` tetikler. Arka plana alınınca ses kesilebilir; kullanıcı bilgilendirilir.
- Yayın izleme: WebRTC yolu yoksa NXM-WS + WebCodecs; o da yoksa "tarayıcınız desteklemiyor" mesajı.
- PWA manifest: ana ekrana eklenebilir, tam ekran.
- Bağlantı kalitesine göre otomatik düşük simulcast katmanı; mobilde varsayılan yayın kalitesi 720p.

---

## 12. Performans, güvenlik, kalite

### 12.1 Performans hedefleri
| Ölçüt | Hedef |
|---|---|
| Soğuk açılış (istemci) | < 2.5 sn |
| Boşta RAM (istemci, host kapalı) | < 250 MB |
| Boşta CPU | ~%0 (arka planda animasyon/timer yok) |
| Ses gecikmesi (LAN) | < 150 ms ağız-kulak |
| Mesaj listesi | 10.000 mesajda 60 fps kaydırma (sanallaştırma) |
| Installer boyutu | < 150 MB |

Kurallar: Electron `backgroundThrottling` açık, gizli pencerede render yok, büyük listeler sanallaştırılır, resimler lazy + boyutlandırılmış sunulur, medya consumer'ları ihtiyaç anında açılır, host süreci ayrı.

### 12.2 Güvenlik
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, sıkı **CSP**, `webSecurity` açık, `setWindowOpenHandler` ile harici linkler varsayılan tarayıcıda, IPC kanalları allowlist + zod doğrulama.
- Host (tünel ile internete açık!): rate limit (`@fastify/rate-limit`), giriş denemesi kilidi, `helmet`, tüm girdiler zod ile doğrulanır, yükleme boyut limiti (varsayılan 50 MB, ayarlanabilir), MIME sniff, dosyalar rastgele adla `uploads/` altında, path traversal koruması.
- Link önizleme (unfurl) host'ta yapılır: **SSRF koruması** (özel/yerel IP blokları reddedilir), zaman aşımı, boyut limiti.
- Mesaj içeriği: Markdown alt kümesi, HTML her zaman escape edilir (XSS).
- Uzaktan kontrol kuralları §7.3.

### 12.3 Diğer gerekli özellikler (eklenenler)
- Bas-konuş (global kısayol), ses aktivasyon eşiği, giriş/çıkış cihazı seçimi, mikrofon testi, yankı engelleme, RNNoise gürültü bastırma.
- Tepsi (tray) simgesi: sustur/sağırlaştır hızlı menü; pencere kapatınca tepsiye küçülme seçeneği.
- Windows ile başlat, tek örnek kilidi (`requestSingleInstanceLock`), `nooxcord://` protokolü.
- Masaüstü bildirimleri (bahsetme, DM), kanal bazında bildirim ayarı, rahatsız etme modu.
- Durum: çevrimiçi / boşta / rahatsız etmeyin / görünmez.
- Özel mesaj (DM) — Faz 4.
- Otomatik güncelleme: `electron-updater` + GitHub Releases.
- Host veritabanı otomatik yedekleme (günlük, son 7) ve dışa/içe aktarma.
- Loglar: `%APPDATA%/NooXCord/logs` (dönen dosyalar), "Hata raporu klasörünü aç" butonu.
- Erişilebilirlik: klavye ile gezinme, odak halkaları, ARIA etiketleri, yeterli kontrast.
- Ses/yayın bağlantı istatistikleri paneli (ping, paket kaybı, bitrate, codec, taşıma yolu).

---

## 13. Yol haritası (fazlar)

| Faz | Kapsam | Bitti tanımı |
|---|---|---|
| **0 — Doğrulama** | Monorepo iskeleti ✅, Electron+Vite ✅; **prototipler:** (a) mediasoup Windows ✅, (b) NXM-WS yerel ✅ / Cloudflare tüneli ✅ (~50 ms) / iPhone Safari izleme ✅ / Android ⏳ (Faz 3), (c) WASAPI process-loopback exclude ✅, (d) overlay masaüstü ✅ / oyun ✅ — **Faz 0 TAMAMLANDI** | 4 prototip sonucu `docs/adr/` altına yazıldı, gerekirse §2 güncellendi |
| **1 — Çekirdek** | Hesaplar (kayıt/giriş/kalıcı oturum/avatar) ✅, guild + davet ✅, metin kanalları ✅, mesaj (Markdown, yanıt, düzenle, sil, yazıyor, okunmadı) ✅, dosya/resim/video ✅, link önizleme ✅, roller + yetkiler + at/yasakla ✅, tasarım sistemi + 62 ikon + logo/ico ✅, masaüstü host süreci + şifreli oturum ✅ | İki istemci tek host'ta sohbet ✅ (tarayıcıda iki farklı kaynakla test edildi) · **iki ayrı PC ile LAN testi ⏳ kullanıcıda** |
| **2 — Ses & Yayın** | Sesli kanal (katıl/ayrıl, sustur/sağırlaştır, kişi başı ses, aygıt seçimi, ses etkinliği + otomatik hassasiyet, bas-konuş — masaüstünde global) ✅, konuşan göstergesi ✅, ekran yayını (monitör/pencere seçici, 5 kalite ön ayarı, akıcılık/netlik, H.264 + 2 katman simulcast) ✅, sistem sesi kendi sesi hariç (native WASAPI process loopback) ✅, çoklu yayın + tek seferlik thumbnail + çoklu izleme (ızgara/odak, tam ekran) ✅, overlay gerçek veriyle ✅. RNNoise → Faz 4 (şimdilik Chromium gürültü bastırma) | 3 kişi aynı anda 2 yayını izleyebiliyor ✅ (`NX_SELFTEST=voice`, 15 kontrol) · yayında yankı yok: exclude modu P3'te doğrulandı, **gerçek iki PC testi ⏳ kullanıcıda** |
| **3 — Ağ & Web** | Ayarlar → Bağlantı: port + canlı kontrol (IPv4/IPv6, kullanan süreç) + boş port öner + yeniden başlat ✅, LAN/Hamachi adresleri + Hamachi servis aç/kapa (UAC) ✅, tünel: Cloudflare Quick Tunnel + Dev Tunnels (indir+imza kontrolü, GitHub girişi, sabit URL, yenile, aç/kapat), kopyala/QR/Ctrl+Shift+L/bildirim ✅, misafir girişi + misafir şifresi + misafir kısıtları ✅, mobil arayüz (alt sekmeler) ✅, NXM-WS tünel modu (ses+mikrofon+yayın izleme, WebRTC başarısızsa otomatik geçiş) ✅, overlay özel tam ekran ipucu ✅, link önizleme DNS sabitleme + resim proxy ✅ | Tünel modunda sese katılma + 2 yayın izleme ✅ (`pnpm test:voice`, C kullanıcısı) · gerçek telefon + tünel testi ✅ (NooXRii, 2026-11-07) — **Faz 3 TAMAMLANDI** |
| **4 — Kontrol & Cila** | Uzaktan kontrol (istek/kabul/her zaman/sağ tık ver, kırmızı çerçeve + rozet — yakalamadan hariç, panik kısayolu, yerel girdi 2 sn öncelik, Win tuşu engeli, pencere paylaşımında odak şartı, 10 dk boşta bitiş, host logu) ✅, DM (migration 2, `dm.open`, yalnızca ortak sunucudakiler) ✅, bildirimler (DM + @bahsetme, kanal/DM sessize alma, rahatsız etmeyin, görev çubuğu yanıp sönme) ✅, tepsi (sustur/sağırlaştır, kapatınca tepsiye, Windows ile başlat) ✅, auto-update (`electron-updater`, yalnızca kurulu uygulama) ✅, günlük DB yedeği (son 7, migration öncesi kopya, dışa/içe aktar, geri yükle) ✅, İngilizce + ana süreç metinleri i18n'de ✅. RNNoise → Faz 5 | Sunucu tarafı §7.3 kuralları test edildi ✅ (`pnpm test`, misafir/tarayıcı reddi, yalnızca kontrolcü girdisi, bırak/geri al/izlemeyi bırak/yayın bitti) · **gerçek iki PC'de SendInput + panik + çerçeve testi ⏳ kullanıcıda** |
| **5 — Paketleme & Deneysel** | NSIS installer (kullanıcı başına, klasör seçimi, TR/EN, Windows < 19041 uyarısı, kaldırırken veri silme sorusu, `nooxcord://`) ✅, VC++ runtime uygulama yanında ✅, uygulama içi güvenlik duvarı kuralı ✅, lisans/üçüncü taraf bildirimleri ✅, README (SmartScreen) ✅ · imzalama ⏳ (sertifika yok), auto-update beslemesi (GitHub Releases) ✅, RNNoise ⏳, opsiyonel exclusive fullscreen overlay hook ⏳ | Paketlenmiş uygulama `NX_SELFTEST=1` + `voice` (16) ✅ · **temiz Windows 10 VM'de setup → çalıştır ⏳ kullanıcıda** |

---

## 14. Paketleme ve kurulum

- `electron-builder` → **NSIS** `NooXCord-Setup-<sürüm>.exe` (x64). Kullanıcı başına kurulum (yönetici gerektirmez) varsayılan; firewall kuralı adımı UAC ister.
- Pakete dahil (Faz 5'te yapıldı, `scripts/dist.mjs`): Electron/Node çalışma zamanı, `mediasoup-worker.exe`, `cloudflared.exe` (lisans metni `resources/licenses/` altında), `native` prebuilt `.node` dosyası (ASAR dışında, `asarUnpack`), web istemcisi build'i `resources/web/` (host da LAN/tünel tarayıcılarına buradan sunar), fontlar (Inter + Space Grotesk, OFL, paket içinde). Veritabanı/şifreleme yerleşik Node modülleriyle yapıldığı için başka native modül yok.
- **Bağımlılık:** `mediasoup-worker.exe` ve native modül VC++ runtime ister. `vc_redist.x64.exe` yönetici istediği için kullanılmadı; `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll` uygulama yanına (`NooXCord.exe` ve `mediasoup-worker.exe` klasörleri) konur (Microsoft'un izin verdiği app-local dağıtım). Windows sürümü < 10.0.19041 ise NSIS uyarır (`apps/desktop/build/installer.nsh`).
- Paketlenmiş uygulamada mediasoup worker `app.asar.unpacked` altındadır; host süreci `MEDIASOUP_WORKER_BIN` ile başlatılır (`localHost.ts` `workerBin()`).
- Opsiyonel kurulum adımı: "Dev Tunnel aracını şimdi indir".
- Kaldırıcı: kullanıcı verisini (`%APPDATA%/NooXCord`) silmeyi **sorar**.
- **Kod imzalama:** İmzasız exe Windows SmartScreen uyarısı verir. İmza sertifikası alınana kadar README'de "Yine de çalıştır" açıklaması bulunur.
- Kullanıcı verisi: `%APPDATA%/NooXCord/` (config, sessions, logs) ve host verisi `%APPDATA%/NooXCord/host/` (db.sqlite, uploads, backups).

---

## 15. Kodlama kuralları

- TypeScript `strict`, `noUncheckedIndexedAccess`; `any` yasak (gerekirse `unknown` + zod).
- ESLint + Prettier; import sırası otomatik.
- Protokol mesajları **yalnızca** `packages/shared` içinde tanımlanır (zod şema + çıkarılmış tip); sunucu ve istemci aynı şemayı kullanır. Mesaj biçimi: `{ t: "chat.send", id, d }`.
- Veritabanı değişiklikleri yalnızca `packages/server/src/db.ts` içindeki MIGRATIONS dizisine yeni eleman ekleyerek (eskiler asla değiştirilmez).
- React: feature klasörü başına `components/ hooks/ store.ts api.ts`; global state minimum.
- Native modül fonksiyonları her zaman `Result` döndürür; JS tarafında hatalar yakalanıp kullanıcıya anlamlı mesaj gösterilir, uygulama çökmez.
- Her yeni protokol mesajı ve izin kontrolü için birim testi; ses/yayın/tünel akışları için e2e senaryosu.
- Commit: Conventional Commits (`feat(voice): ...`).

---

## 16. Harici araçlar / MCP

Projeyi geliştirmek için **zorunlu harici MCP yok.** Önerilenler (hepsi ücretsiz):
| MCP | Neden | Durum |
|---|---|---|
| **Context7** (`@upstash/context7-mcp`) | Electron, mediasoup, Fastify, devtunnel gibi hızlı değişen kütüphanelerin güncel dokümantasyonu | **Önerilir** |
| **Playwright MCP** (`@playwright/mcp`) | Web/mobil arayüzü tarayıcıda gerçek viewport'larla test etme | Opsiyonel (Claude Desktop'ın yerleşik tarayıcısı da yeterli olabilir) |
| **GitHub MCP** | Release, issue yönetimi | Opsiyonel (`gh` CLI de yeterli) |

Harici, ücretli bir servis (TURN sağlayıcı, bulut sunucu vb.) **kullanılmaz.**

Geliştirme makinesinde gereken araçlar: Node.js LTS, pnpm, Rust (stable, `x86_64-pc-windows-msvc`), Visual Studio Build Tools (C++ workload, mediasoup ve native derleme için), Python 3 (mediasoup worker derlemesi için), Git.

---

## 17. Açık sorular / riskler

1. **Tünel üzerinden medya (NXM-WS)** — Faz 0'da iPhone dahil doğrulandı; kalan iş: ses tamponu kayma düzeltmesi, telefondan mikrofon gönderimi, Android testi.
2. **Exclusive fullscreen overlay** anti-cheat riski taşır — deneysel ve opt-in kalacak.
3. Host upload kapasitesi çok izleyicili yayınları sınırlar — UI'da şeffaf gösterilecek.
4. Tünel sağlayıcılarının şartları değişebilir (Quick Tunnel "test amaçlı", Dev Tunnels limitli) — `TunnelProvider` arayüzü sayesinde sağlayıcı değiştirilebilir; UDP taşıyan playit.gg 3. sağlayıcı adayı.
5. Hamachi'nin programatik kontrolü sınırlı — algılama + servis aç/kapa ile yetinilecek.
6. Kod imzalama sertifikası olmadan SmartScreen uyarısı kaçınılmaz.
7. ~~Link önizleme DNS rebinding~~ → Faz 3'te çözüldü: adres soketin kendi DNS çözümlemesinde kontrol ediliyor (kontrol edilen IP = bağlanılan IP).
8. ~~Önizleme görselleri üçüncü taraftan~~ → Faz 3'te çözüldü: `/proxy/img/<imza>/<url>` (HMAC imzalı, yalnızca host'un ürettiği linkler; anahtar `proxy.key`).
9. Ek dosyalar yetkisiz ama tahmin edilemez URL'lerle sunuluyor (`/files/<zaman+rastgele id>/<ad>`); HTML/SVG vb. her zaman indirme olarak, `sandbox` CSP ile.
10. Port kontrolü 0.0.0.0, :: ve 127.0.0.1'i ayrı ayrı dener (Windows'ta `[::]:port` tutulurken `0.0.0.0` boş görünebiliyor) ✅.
11. `%APPDATA%/NooXCord/host/` altında bu projeden önce oluşmuş bir `db.sqlite` + `logs/` + `uploads/` var (6 Kasım, kaynağı bilinmiyor). Host kendi dosyasını (`nooxcord.db`) kullanır; o dosyalara dokunulmadı.
12. Medya portu (ana port + 1) LAN'da açık olmalı; WebRTC ICE başarısız olursa istemci "medya portu erişilebilir olmalı" uyarısı verir. Host yeni bir ağ arayüzü (ör. Hamachi sonradan bağlandı) için ses sunucusunu yeniden başlatmalı — şimdilik adresler ilk sese katılmada alınır.
13. Global bas-konuş ve **mikrofon aç/kapat kısayolu** (Ayarlar → Ses, `nx.voice.muteKey`, ör. `Ctrl+Shift+KeyM`, `F9`, `Mouse4`) `GetAsyncKeyState` ile 15 ms'de bir yoklanır (yalnızca sesteyken) → oyun öndeyken de çalışır (`media:setHotkeys`). Değiştiricisiz harf kısayolu, NooXCord'da yazı alanı odaktayken tetiklenmez. Fare orta/yan tuşu kısayolda seçilebilir; bas-konuş ayarında henüz değil. Yönetici olarak çalışan oyunlarda tuş okunamayabilir.
14. Tünel modu (NXM-WS) sınırları: tünelden giren **ekran** yayını açamaz, yalnızca izler (kamera açabilir — §6.5, WebCodecs `VideoEncoder` gerekir); video her zaman düşük simulcast katmanı; mikrofon için tarayıcıda WebCodecs `AudioEncoder` gerekir (yoksa yalnızca dinleme).
15. ~~Ana süreç metinleri~~ → Faz 4'te `main.*` anahtarlarına taşındı (ana süreç `tr.json`/`en.json`'u derleme anında paketler, dil renderer ayarını izler). **Kalan:** host'un döndürdüğü hata mesajları (`fail(...)`) Türkçe; İngilizce arayüzde de Türkçe görünür → hata kodu + anahtar ile çevrilmeli.
16. Tünel açılışta otomatik başlamaz (bilinçli: herkese açık bağlantı kullanıcı istemeden açılmasın); her seferinde Ayarlar → Bağlantı'dan açılır.
17. Uzaktan kontrol: panik kısayolu sabit (`Ctrl+Alt+Shift+Esc`), ek engellenecek kombinasyon ayarı yok (yalnızca Win tuşları engelli) — ayar ekranı sonraya. Yönetici yetkili pencereler girdi almaz (UIPI), istek kartında yazıyor.
18. Auto-update: herkese açık repo `github.com/nightcrewlab/NooXCord`, `electron-builder.yml` `publish: github`. Sürüm çıkarmak: `apps/desktop/package.json` sürümünü artır → `pnpm dist` → `gh release create vX.Y.Z release/NooXCord-Setup-X.Y.Z.exe release/NooXCord-Setup-X.Y.Z.exe.blockmap release/latest.yml` (taslak/ön sürüm değil). Kurulu uygulama açılıştan 15 sn sonra ve 6 saatte bir bakar, indirir, çıkışta kurar. 0.5.0 beslemesiz derlendi → 0.5.1 bir kez elle kurulmalı.
19. Yedekler yalnızca veritabanını kapsar (`%APPDATA%/NooXCord/host/backups`), yüklenen dosyalar dahil değil.
20. Migration 2 `channels` tablosunu yeniden kurar (DM için `guild_id` boş olabilir); migration sırasında foreign key kapalı, sonra `foreign_key_check`. Eski şema dosyası önce `backups/…-v1.db` olarak kopyalanır.
21. Okunmamış işareti: DM'ler `markRead`'de hiç okunmuş sayılmıyordu (yalnızca guild kanalları aranıyordu) ve pencere arka plandayken gelen mesajlar pencere öne gelince okunmuyordu → ikisi de düzeltildi (Faz 5 başı).
22. iPhone Safari'de yalnızca `<video>` tam ekran olabilir: yayın döşemesi önce element tam ekranını, sonra `webkitEnterFullscreen`, en son CSS ile pencereyi kaplamayı dener.
