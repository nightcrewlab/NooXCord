# NooXCord — CLAUDE.md

> **Geliştirici:** NooXRii · **Platform:** Windows 10 (2004 / build 19041+) ve Windows 11 masaüstü + mobil/masaüstü web tarayıcı istemcisi
> **Tür:** Discord benzeri sesli/görüntülü sohbet ve ekran paylaşımı uygulaması; sunucu Render.com'da, veriler Turso'da, medya P2P
> **Durum:** Faz 6 (Render + Turso + P2P, ADR 0003, 2026-11-23) — kod tamam ve testli (`pnpm test` 4 paket, `pnpm test:voice` 29 kontrol); **kalan: Render servisi + Turso veritabanı kurulumu ve gerçek iki ağdan P2P testi (kullanıcıda)**. Eski yerel-host sürümü (Faz 0–5: mediasoup, tünel, Hamachi) kullanıcıda yedekli; aşağıdaki tarihçe notları onu anlatır. Repo + auto-update: `github.com/nightcrewlab/NooXCord` (§17.18). Bu dosya projenin tek doğruluk kaynağıdır; bir karar değişirse önce burası güncellenir. Mimari kararlar `docs/adr/` altında.

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

NooXCord; sunucusu (**Host**) Render.com'un ücretsiz web servisinde sürekli açık duran, herkesin masaüstü uygulamasıyla veya tarayıcıdan bağlandığı bir sohbet uygulamasıdır (ADR 0003). Veriler Turso'da (libSQL) saklanır. Ses, kamera ve yayınlar sunucudan geçmez: kanaldaki kişiler birbirine doğrudan WebRTC ile bağlanır (P2P mesh); sunucu yalnızca sohbeti ve bağlantı kurma mesajlarını taşır.

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
| Ağ | Render.com (sabit HTTPS adresi, tünel/port/Hamachi gerekmez) · medya P2P: STUN + isteğe bağlı TURN (Cloudflare veya statik, sunucu ortam değişkenleri) |
| Dağıtım | Tek `NooXCord-Setup-x.y.z.exe`; kurulduğunda ek bir şey kurmaya gerek kalmadan çalışır |

---

## 2. Mimari kararı

### 2.1 Seçilen yığın
| Katman | Teknoloji | Neden |
|---|---|---|
| Masaüstü kabuğu | **Electron** (güncel kararlı sürüm) + `electron-builder` (NSIS) | WebRTC, `desktopCapturer`, çoklu monitör, şeffaf overlay penceresi, global kısayollar ve native modül desteği tek pakette. Tauri/WebView2'de ekran yakalama ve overlay kontrolü yetersiz. |
| Dil | **TypeScript (strict)** her yerde; native kısım **Rust + napi-rs** | Tip güvenliği; Rust ile güvenli Windows API erişimi ve prebuilt `.node` dosyaları |
| UI | **React 19 + Vite**, **Zustand** (state), **CSS Modules + CSS değişkenleri** (tasarım token'ları), `@tanstack/react-virtual` (mesaj listesi) | Hafif, hızlı; aynı istemci hem Electron'da hem tarayıcıda çalışır |
| Host sunucusu | **Node.js** (Render.com web servisi, tek dosya bundle `packages/server/dist/server.mjs`): **Fastify** (HTTP/REST + statik web istemcisi), **ws** (gerçek zamanlı protokol + WebRTC sinyali), **zod** (şema doğrulama) | Sürekli açık, sabit HTTPS adresi; PC'ye bağlı değil (ADR 0003) |
| Medya (P2P) | Tarayıcının kendi **WebRTC**'si, kanaldaki her kişi çifti arasında bir `RTCPeerConnection` (`packages/client/src/media/engine.ts`); sunucu yalnızca `rtc.signal` aktarır | Render UDP taşımaz ve medyayı taşıyacak CPU/trafiği yok; mesh küçük gruplar için yeterli |
| Veritabanı | **SQLite**: çalışırken yerel **`node:sqlite`** dosyası (WAL), her yazma sırayla **Turso**'ya yansıtılır (`@libsql/client/web`, `mirror.ts`); açılışta yerel dosya Turso'dan kurulur. Numaralı migration'lar `db.ts` içinde. Yüklenen dosyalar da veritabanında (`blobs`, 512 KB parçalar) | Render diski kalıcı değil; senkron sorgu kodu değişmedi |
| Şifreleme | Node yerleşik **`scrypt`** (N=2¹⁵, r=8, p=1) şifre hash'i; Electron `safeStorage` (DPAPI) ile istemci token saklama | Native modül gerektirmez |
| Medya işleme | Avatar / sunucu simgesi **istemcide** canvas ile 256px kare WebP'ye çevrilir; sunucu magic-byte ile tür doğrular. RNNoise (WASM) Faz 2 | `sharp` gerekmedi |
| Native modül | `packages/native` (Rust/napi-rs): WASAPI process-loopback, SendInput, pencere/monitör listeleme, bas-konuş tuş durumu | |
| Tünel | ~~cloudflared / devtunnel~~ → kaldırıldı (ADR 0003; Render zaten HTTPS) | ADR 0001 geçersiz |
| Test | **Vitest** (birim), **Playwright** (web + Electron e2e) | |
| Paket yöneticisi | **pnpm workspaces** | |

### 2.2 Süreç modeli
```
            Render.com (ücretsiz web servisi)                     Turso (libSQL)
  ┌────────────────────────────────────────────┐            ┌──────────────┐
  │ node server.mjs: Fastify + ws               │  her yazma │  kalıcı      │
  │  • REST, sohbet, izinler, davet, yüklemeler │ ─────────► │  veritabanı  │
  │  • web istemcisini sunar                    │ ◄───────── │              │
  │  • WebRTC sinyali (rtc.signal) aktarır      │  açılışta  └──────────────┘
  │  • yerel node:sqlite çalışma kopyası        │
  └────────────────────────────────────────────┘
        ▲ HTTPS / WSS (sohbet + sinyal)
        │
  Masaüstü (Electron)   Tarayıcı (PC / iPhone / Android)
        ◄────── WebRTC P2P (ses, kamera, yayın) ──────►
```
- Masaüstü uygulaması yalnızca **istemcidir** (ana süreç: pencere/tepsi/kısayol/overlay, native modül, auto-update; renderer: React istemci). Varsayılan sunucu derlemede `VITE_NX_DEFAULT_HOST` ile verilir; sunucu seçicide başka adres de girilebilir.
- Render ücretsiz servis 15 dk trafiksiz kalınca uyur (ilk giren ~1 dk bekler) ve her yeniden başlatmada diski sıfırlanır → veriler Turso'da.

### 2.3 Medya taşıma (ADR 0003)
- **Mesh:** kanaldaki her kişi çifti arasında tek `RTCPeerConnection`. Teklifi küçük `userId`'li taraf verir; her teklif yeni bir `gen` taşır ve eski bağlantının yerine geçer (kopan bağlantı böyle yeniden kurulur: artan aralıkla, en fazla 30 sn). Karşı tarafın teklifinden önce gelen ICE adayları beklenir, kendi teklifinden önce bulunan adaylar teklif gidince gönderilir.
- Her bağlantıda sabit **4 transceiver**: 0 mikrofon · 1 kamera · 2 ekran · 3 ekran sesi. Parçalar `replaceTrack` ile değişir → yeniden müzakere yok. Kamera her zaman gider (görünürlük `VoiceState.camera` ile); ekran + ekran sesi yalnızca yayının izleyicilerine (`StreamInfo.viewers`, sunucu yayar).
- Opus: mikrofon DTX, ekran sesi stereo 128 kbps (SDP `fmtp` ayarı, `tuneOpus`). Alınan seste `jitterBufferTarget` 80 ms (yayın sesi 120). Sunucunun susturduğu (`suppressed`) kişinin sesi alıcıda kısılır, kendi istemcisi de göndermez.
- ICE: STUN (Google + Cloudflare) + isteğe bağlı TURN (`NX_ICE_SERVERS` JSON, `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` veya `CLOUDFLARE_TURN_KEY_ID`/`CLOUDFLARE_TURN_API_TOKEN`; `ice.ts`), `voice.join` yanıtıyla istemciye gider.
- iOS: `AudioContext` ve `getUserMedia` dokunma olayının içinde, ilk `await`'ten önce başlatılır (değişmedi).

### 2.4 Bant genişliği gerçeği
Mesh'te sunucu medya taşımaz ama **her izleyici yayıncının upload'undan ve kodlayıcısından ayrı beslenir** (kişi başı ayrı H.264 kodlama, simulcast yok). Pratik sınır: seste ~6 kişi, bir yayına 2–4 izleyici. Ön ayarın bitrate'i her izleyici için ayrı harcanır.

---

## 3. Klasör yapısı (monorepo)

```
NooXCord/
├─ CLAUDE.md
├─ package.json / pnpm-workspace.yaml / tsconfig.base.json
├─ apps/
│  └─ desktop/                 # Electron
│     ├─ src/main/             # main process: windows, tray, ipc, overlay, remote control, updater, logs
│     ├─ src/preload/          # contextBridge → window.nx (typed)
│     ├─ resources/            # icon.ico, tray ikonları
│     └─ electron-builder.yml
├─ packages/
│  ├─ client/                  # React istemci (Electron renderer + web), responsive
│  │  ├─ src/app/              # rotalar, layout (desktop / mobile)
│  │  ├─ src/features/         # auth, guilds, channels, chat, voice, stream, remote, overlay, settings
│  │  ├─ src/media/            # P2P WebRTC motoru (engine.ts), VAD, RNNoise/GTCRN, sistem sesi
│  │  ├─ src/platform/         # DesktopPlatform | WebPlatform adapter'ları
│  │  ├─ src/styles/           # tokens.css, temalar
│  │  └─ src/i18n/
│  ├─ server/                  # Host: Fastify, ws, sinyal (voice.ts), db + Turso yansıtma, blobs, auth, link unfurl; build.mjs → dist/server.mjs
│  ├─ shared/                  # protokol tipleri, sabitler, izin bitleri; zod şemaları ayrı: "@nooxcord/shared/schemas" (yalnızca sunucu import eder → istemci paketine zod girmez)
│  ├─ native/                  # Rust napi-rs: loopback audio, input, monitors
│  └─ icons/                   # Elle çizilmiş SVG ikonlar: kaynak src/icons.ts, svg/*.svg ve sheet.svg `pnpm icons` ile üretilir
├─ prototypes/                 # Faz 0 doğrulama prototipleri (ürün koduna import edilmez)
├─ render.yaml                 # Render Blueprint (sunucu)
├─ assets/brand/               # logo.svg, icon kaynakları
├─ docs/adr/                   # mimari karar kayıtları (ADR)
└─ scripts/                    # build, icon üretimi, release
```

---

## 4. Komutlar

Paket yöneticisi **pnpm 9** (`node-linker=hoisted`, Electron/native modüller için). Electron binary'si inmediyse: `node node_modules/electron/install.js`.

```bash
pnpm install
pnpm dev            # Electron + Vite HMR (sunucu seçicide http://localhost:47820 veya Render adresi)
pnpm dev:host       # yalnızca sunucu (tsx watch, yerel veritabanı; TURSO_* verilirse Turso) → http://localhost:47820 (web istemcisini de sunar; önce client build)
pnpm dev:web        # yalnızca web istemcisi (Vite :5173, VITE_NX_HOST ile host seçilir; varsayılan localhost:47820)
pnpm typecheck      # tüm paketler
pnpm test           # sunucu uçtan uca (23) + uzaktan kontrol, DM, P2P sinyal (18) + Turso yansıtma (6, yerel libSQL dosyasıyla) + link önizleme SSRF / resim proxy
pnpm build          # client (vite) + sunucu bundle (esbuild → packages/server/dist/server.mjs) + desktop main/preload
pnpm start          # node packages/server/dist/server.mjs (Render'daki gibi; ayarlar ortam değişkenlerinden, bkz. server/src/dev.ts)
pnpm brand          # assets/brand/*.svg → icon.ico, favicon, PWA ikonları
pnpm icons          # ikon tablosu → packages/icons/svg/*.svg + sheet.svg
```

Masaüstü kendi kendine testleri (pencere göstermeden, geçici userData ile):
```bash
NX_SELFTEST=1 electron apps/desktop        # safeStorage (NX_UITEST_HOST ile sunucuya erişim de)
NX_SELFTEST=ui NX_UITEST_HOST=http://127.0.0.1:47820 NX_SHOT=shot.png electron apps/desktop   # arayüz + file:// → host HTTP/WS
# 3 kullanıcı P2P mesh, 2 yayın (biri sesli), herkes izliyor, kameralar, izlemeyi bırak/yayın bitti/ayrıl/yeniden katıl.
# Sunucu bundle'ını Electron'un Node'uyla kendisi başlatır (47850); NX_UITEST_HOST=... ile dış sunucu
pnpm test:voice        # = client + server build + NX_SELFTEST=voice electron apps/desktop  (29 kontrol, tiyatro görünümü ve sığma + RNNoise/GTCRN dahil; NX_SHOT=... ekran görüntüsü)
# UI testi giriş yapıp bir betik çalıştırabilir: NX_UITEST_TOKEN=<token> NX_UITEST_JS="<js>" (ör. ayarlar sayfasını açmak)
# Güncelleme köşe kartı: NX_UITEST_UPDATE=downloading|ready (sahte durum, sürüm 9.9.9)
```
Native modül (Rust, `packages/native`): `pnpm build:native` → `nooxcord-native.win32-x64.node` (loopback ses, bas-konuş tuş durumu, özel tam ekran tespiti).
Render: `render.yaml` Blueprint (yalnızca server + client filtreli kurulum, Node 24, `/api/info` sağlık kontrolü). Ortam değişkenleri README'de.

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
```
Tek tık: kökte `paketle.bat` (= `pnpm dist`, sonra Gezgin'de exe'yi gösterir) ve `release-yukle.bat` (dosyaları + `latest.yml` sürümünü kontrol eder, onay ister → değişiklik varsa commit (mesaj sorar, boşsa `chore(release): v<sürüm>`) → push → `gh release create v<sürüm> … --target <push edilen commit> --generate-notes`).
`scripts/dist.mjs`: `release/app` klasörünü hazırlar (esbuild çıktıları + yalnızca dış bırakılan modüller: `electron-updater`, `@nooxcord/native` (index.js + .node)), sonra `apps/desktop/electron-builder.yml` ile NSIS üretir. Masaüstü sürümü derlerken `VITE_NX_DEFAULT_HOST=https://<servis>.onrender.com` verilmeli (varsayılan sunucu). Gerekenler: `pnpm build:native` çıktısı, Visual Studio'nun VC++ x64 runtime DLL'leri (en yenisi otomatik bulunur; yoksa `.tools/vcruntime/`).

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
- Misafir kısıtları: varsayılan olarak ekran yayını açamaz, uzaktan kontrol isteyemez, sunucu yönetemez (misafirde @everyone rolü `DEFAULT_ROLE_PERMS.guest` ile maskelenir). **Kamera açabilir** (`VIDEO` misafir varsayılanında). Host misafire **açık bir rol** verirse `STREAM` (tarayıcıdan ekran yayını, §6.6) ve `REQUEST_REMOTE_CONTROL` (kontrol isteme, §7.3) açılır; `ADMINISTRATOR` hiçbir zaman. Misafir kontrol **edilemez** (yayıncı tarafı her zaman masaüstü uygulaması).
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
- Codec (P2P, ADR 0003): Ayarlarda **Otomatik / AV1 / VP9 / H.264** (`streamCodec`); Otomatik = H.264, sonra VP8. Tercih bağlantı kurulurken (`setCodecPreferences`) uygulanır, sesteyken değiştirmek yeni bağlantılara etki eder. Kişi başı ayrı kodlama, simulcast yok. *Tarihçe (mediasoup):* Otomatik: `mediaCapabilities.encodingInfo` donanım (`powerEfficient`) diyorsa AV1 (yalnızca `L1T3` SVC; AV1 `L2T3_KEY` mediasoup 3.32'de izleyicide çözülmedi), yoksa VP9 (`L2T3_KEY`, yoksa `L1T3`), o da yoksa H.264 (2 katman simulcast). mediasoup VP9/AV1'i simulcast değil yalnızca SVC olarak kabul eder. AV1/VP9'u çözemeyen izleyici (tünel, iPhone, eski istemci; `stream.watch` `codecs` ile bildirir) izlemeye başlayınca host `StreamInfo.compat` açar → yayıncı aynı yakalamadan ikinci bir H.264 simulcast producer'ı (`screen-compat`) gönderir, ihtiyaç bitince kapanır. Kamera her zaman H.264.

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
- *Tarihçe — tünel modu (kaldırıldı):* tarayıcı WebCodecs `VideoEncoder` ile H.264 constrained baseline (`avc1.42e01f`, Annex-B; yoksa avcC → Annex-B dönüşümü) kodlar, kareler `<video>` → canvas üzerinden alınır (iPhone Safari'de de çalışır), 20 fps, ≤640 px, 450 kbps. WS çerçevesi `[4][key][ts90k][AU]` → host RTP'ye paketler (tek NAL / FU-A, `rtp.ts` `packetizeH264`) → DirectTransport producer. İzleyicilerden gelen PLI/FIR → `[5]` çerçevesi → tarayıcı anahtar kare üretir; ayrıca 3 sn'de bir anahtar kare.
- Telefonda birden fazla kamera varsa **ön/arka çevir** düğmesi (producer kalır, `replaceTrack`). Masaüstünde kamera seçimi Ayarlar → Ses.

### 6.6 Tarayıcıdan ekran yayını
- Tarayıcı `getDisplayMedia` sunuyorsa (masaüstü Chrome/Edge/Firefox; Android'de tarayıcıya bağlı, iPhone Safari'de **yok**) "Yayın aç" düğmesi görünür; izin `STREAM` (misafire açık rol ile, §5.2).
- Masaüstüyle aynı yol (P2P, preset, sekme sesi tarayıcı verirse).
- *Tarihçe — tünel modu (kaldırıldı):* kameradaki gibi WebCodecs H.264 (`avc1.42e01f`), ≤1280×720, 15 fps, 1.2 Mbps; WS çerçevesi `[6][key][ts90k][AU]`. **Yayın sesi** (tarayıcının verdiği sekme/sistem sesi; masaüstünde native loopback) WebCodecs Opus stereo 96 kbps → `[7][opus]` → host `screen-audio` producer (2026-11-08) → host `rtp.ts` ile paketler → DirectTransport producer (`vid[1]` SSRC). PLI/FIR, SSRC'ye göre `[5][0|1]` (kamera/ekran) anahtar kare isteğine çevrilir. Medya WS'i mesaj başına 1 MB'a kadar kabul eder (önceden 16 KB; ekran anahtar kareleri sığmıyordu).

### 6.4 Çoklu yayın ve izleme
- Aynı sesli kanalda birden fazla kişi aynı anda yayın açabilir.
- Yayın başladığında yayıncı **tek bir kare** yakalar (JPEG, 480px genişlik) ve host'a gönderir → kanal görünümünde **tek seferlik thumbnail** kartı (canlı güncellenmez; trafik tasarrufu). Kartta: yayıncı adı, kalite rozeti, izleyici sayısı, **"Yayını İzle"** butonu.
- "Yayını İzle"ye basılmadan yayıncı o kişiye ekran **göndermez** (`stream.watch` → `StreamInfo.viewers` → yayıncı `replaceTrack`).
- Birden fazla yayın aynı anda izlenebilir: ızgara görünümü, odak (büyük) görünümü, her yayın için ayrı ses seviyesi, tam ekran, ayrı pencereye çıkar (pop-out, masaüstü).
- **Tiyatro görünümü:** sesteyken bir yayın izlenmeye başlanınca üye listesi gizlenir ve yayın sahnenin tamamını kaplar. Altta izlenmeyen herkesin şeridi durur (avatar veya küçük kamera, konuşan yeşil çerçeve; izlenmeyen yayın tek seferlik önizlemesiyle durur, tıklayınca izlenir); birden fazla yayın izlenirken yan yana durur, birine tıklayınca o sahneyi kaplar ve diğerleri gizlenir, ona tekrar tıklayınca yine yan yana (tam ekran düğmesi ve uzaktan kontrol tıklamaları bunu tetiklemez); şerit küçük tutamaçla gizlenir/geri gelir (`stripHidden` ayarı). Kendisi de yayındaysa şeridin üstünde "Senin yayının" çubuğu (izleyiciler + sağ tık kontrol ver, durdur).

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
- Kontrol **isteyen** taraf her istemci olabilir (masaüstü, tarayıcı, telefon — dokunma = sol tık), yeter ki rolünde `REQUEST_REMOTE_CONTROL` olsun; misafirler bunu yalnızca açık bir rolden alır (2026-11-07 kararı, NooXRii). Kontrol **edilen** taraf yalnızca masaüstü uygulamasındaki kayıtlı kullanıcıdır (`StreamInfo.controllable`, SendInput); tarayıcı yayınında düğme çıkmaz, sunucu da reddeder. Her istek yayıncının onayını ister.
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
- **Görsel dil (2026-11-10):** logonun iki öğesi her yerde tekrar eder — *squircle* (avatarlar, sunucu simgeleri, boş durum ikonları) ve *ses dalgası halkaları* (boş durum / sese katıl / giriş arka planı). Paneller üstten hafif ışık alan kartlardır; seçili kanal ve ayar sekmesi turuncu şerit + soldan sağa sönen vurgu; diyalogların üst kenarında ince turuncu çizgi; sesli kanal kontrolleri tam genişlik çubuk değil ortada **yüzen dock**; katılımcılar sahnenin ortasında toplanır; kullanıcı satırı ve ses bağlantı çubuğu panel içinde ayrı "pod"lardır.
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
--nx-radius-s: 8px; --nx-radius-m: 12px; --nx-radius-l: 18px;
--nx-squircle: 32%;     /* avatar + sunucu simgesi: logodaki squircle silueti (daire değil) */
--nx-edge / --nx-panel  /* panel kenarı (ince beyaz çizgi) ve üstten hafif parlayan panel zemini */
--nx-rings              /* ses dalgası halkaları: boş durumlar, sese katıl ve giriş ekranı arka planı */
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

## 10. Ağ (ADR 0003)

- Sunucu Render.com'da sabit HTTPS adresinde: port, güvenlik duvarı, Hamachi, tünel **yok** (kodları kaldırıldı; eski sürüm yedekte). Tarayıcılar mikrofon/kamera için HTTPS ister → Render adresi bunu karşılar.
- Ayarlar → Bağlantı: bağlı sunucu, sürüm, WebSocket durumu ve telefonla açmak için QR kod.
- P2P bağlantı kurulamazsa (simetrik NAT / mobil CGNAT) istemci kişi başına artan aralıkla yeniden dener ve ikinci denemede uyarır; kalıcı çözüm sunucuya TURN ortam değişkenleri (§2.3).
- Render ücretsiz servis: 15 dk trafiksiz uyku (sesteyken WS ping'leri trafik sayılır), aylık trafik sınırı (yalnızca sohbet + sinyal + dosyalar geçer).

### 10.6 Davet bağlantısı
`nooxcord://join?url=<host kökeni>&invite=<davet>` (eski biçim `h=&p=&code=` de okunur; protokol NSIS ile kayıtlı) + düz HTTPS bağlantı (`<sunucu>/?invite=<kod>`). Masaüstü uygulaması bağlantıyla açılınca (ilk açılış veya `second-instance`) o host'a geçer; web istemcisinin giriş ekranında (PC tarayıcısı) **"Uygulamada aç"** bu bağlantıyı açar → tünele masaüstünden bağlanmak için harici tarayıcı gerekmez (sunucu seçicide tünel URL'si de yapıştırılabilir). Davet kodları süre/kullanım limitli.

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
- Bas-konuş (global kısayol), ses aktivasyon eşiği, giriş/çıkış cihazı seçimi, mikrofon testi ("Kendini duy" ile), yankı engelleme, gürültü bastırma: Kapalı / Hafif (Chromium) / **Güçlü (RNNoise, varsayılan)** / En güçlü (GTCRN) — `media/denoise.ts`, `@sapphi-red/web-noise-suppressor` (MIT; RNNoise BSD-3, GTCRN MIT), AudioWorklet + WASM (CSP'de `'wasm-unsafe-eval'`). Model açıkken tarayıcı bastırması kapatılır; ses kapısı (VAD) temizlenmiş sesi dinler.
- Tepsi (tray) simgesi: sustur/sağırlaştır hızlı menü; pencere kapatınca tepsiye küçülme seçeneği. Susturulmuş/yayında rozeti ikonun neredeyse yarısını kaplar (16px'de okunsun diye; `scripts/build-brand.mjs`).
- **Mikrofon cızırtısı kendi kendini onarır:** mikrofon zinciri (gürültü bastırma + seviye ölçer) paylaşılan bağlamdan ayrı, kendi `AudioContext`'inde (`level.ts` `micContext()`, sesten çıkınca askıya alınır). Seviye worklet'i "ses arasında 1–4 tam sessiz blok" (yakalama tamponu boşalması = cızırtı) sayar; 10 sn'de ≥15 olursa mikrofon yeniden açılır (en fazla 30 sn'de bir) — kullanıcının gürültü modunu değiştirip geri almasının otomatik hali. Yayın sistem sesi tamponu hedefi 70 → 120 ms (`pcm.ts`).
- Windows ile başlat, tek örnek kilidi (`requestSingleInstanceLock`), `nooxcord://` protokolü.
- Masaüstü bildirimleri (bahsetme, DM), kanal bazında bildirim ayarı, rahatsız etme modu.
- Durum: çevrimiçi / boşta / rahatsız etmeyin / görünmez.
- Özel mesaj (DM) — Faz 4.
- Otomatik güncelleme: `electron-updater` + GitHub Releases.
- Veritabanı yedekleri: Turso'nun kendi zaman içinde geri dönüşü (point-in-time); uygulama içi yedekleme kaldırıldı (ADR 0003).
- Loglar: `%APPDATA%/NooXCord/logs` (dönen dosyalar): `main.log` (ana süreç hataları), sunucu çıktısı Render panelindeki loglarda (bağlanma/kopma, sese katılma, yayın, Turso yansıtma hataları), "Hata raporu klasörünü aç" butonu.
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
| **5 — Paketleme & Deneysel** | NSIS installer (kullanıcı başına, klasör seçimi, TR/EN, Windows < 19041 uyarısı, kaldırırken veri silme sorusu, `nooxcord://`) ✅, VC++ runtime uygulama yanında ✅, uygulama içi güvenlik duvarı kuralı ✅, lisans/üçüncü taraf bildirimleri ✅, README (SmartScreen) ✅ · imzalama ⏳ (sertifika yok), auto-update beslemesi (GitHub Releases) ✅, RNNoise + GTCRN ✅, opsiyonel exclusive fullscreen overlay hook ⏳ | Paketlenmiş uygulama `NX_SELFTEST=1` + `voice` (16) ✅ · **temiz Windows 10 VM'de setup → çalıştır ⏳ kullanıcıda** |
| **6 — Render + Turso + P2P** (ADR 0003) | Sunucu tek bundle + `render.yaml` ✅, Turso yansıtma (yazma sırası, transaction grubu, açılışta kurulum, migration sonrası tam yükleme, cascade tetikleyicileri) ✅, dosyalar veritabanında ✅, mediasoup → P2P mesh (4 sabit transceiver, `rtc.signal`, `gen` ile yeniden kurma, STUN/TURN) ✅, masaüstünden yerel host/tünel/Hamachi/port/güvenlik duvarı/yedekleme kaldırıldı ✅, varsayılan sunucu (`VITE_NX_DEFAULT_HOST`) ✅ | `pnpm test` (23 + 18 + 6 + unfurl) ✅ · `pnpm test:voice` 29 ✅ · **Render + Turso kurulumu ve iki farklı ağdan gerçek P2P testi ⏳ kullanıcıda** |

---

## 14. Paketleme ve kurulum

- `electron-builder` → **NSIS** `NooXCord-Setup-<sürüm>.exe` (x64). Kullanıcı başına kurulum (yönetici gerektirmez).
- Pakete dahil (`scripts/dist.mjs`): Electron çalışma zamanı, `native` prebuilt `.node` dosyası (ASAR dışında, `asarUnpack`), web istemcisi build'i `resources/web/` (pencere `file://` ile açar), fontlar (Inter + Space Grotesk, OFL, paket içinde), lisans bildirimleri. Sunucu pakette **yok** (Render'da).
- **Bağımlılık:** native modül VC++ runtime ister. `vc_redist.x64.exe` yönetici istediği için kullanılmadı; `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll` `NooXCord.exe` yanına konur (Microsoft'un izin verdiği app-local dağıtım). Windows sürümü < 10.0.19041 ise NSIS uyarır (`apps/desktop/build/installer.nsh`).
- Kaldırıcı: kullanıcı verisini (`%APPDATA%/NooXCord`) silmeyi **sorar**.
- **Kod imzalama:** İmzasız exe Windows SmartScreen uyarısı verir. İmza sertifikası alınana kadar README'de "Yine de çalıştır" açıklaması bulunur.
- Kullanıcı verisi: `%APPDATA%/NooXCord/` (config, sessions, logs). Sunucu verisi Turso'da.

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
| **Context7** (`@upstash/context7-mcp`) | Electron, Fastify, libSQL/Turso, WebRTC gibi hızlı değişen kütüphanelerin güncel dokümantasyonu | **Önerilir** |
| **Playwright MCP** (`@playwright/mcp`) | Web/mobil arayüzü tarayıcıda gerçek viewport'larla test etme | Opsiyonel (Claude Desktop'ın yerleşik tarayıcısı da yeterli olabilir) |
| **GitHub MCP** | Release, issue yönetimi | Opsiyonel (`gh` CLI de yeterli) |

Harici **ücretli** servis kullanılmaz: Render (ücretsiz web servisi), Turso (ücretsiz katman) ve isteğe bağlı Cloudflare TURN (ücretsiz kota) kartsız/ücretsiz planlarda.

Geliştirme makinesinde gereken araçlar: Node.js LTS, pnpm, Rust (stable, `x86_64-pc-windows-msvc`), Visual Studio Build Tools (C++ workload, native derleme için), Git.

---

## 17. Açık sorular / riskler

> **ADR 0003 (2026-11-23) sonrası:** 1, 4, 5, 10, 12, 14, 16, 19, 23, 26, 27 ve 28'in tünel / Hamachi / mediasoup / yerel host kısımları geçersiz; tarihçe olarak duruyor. Yeni riskler 30–34.

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
12. Medya portu (ana port + 1) LAN'da açık olmalı; WebRTC ICE başarısız olursa istemci o arama için tünel moduna (NXM-WS) düşer — **yalnızca o arama**: sonraki katılım yine WebRTC dener (2026-11-08; önceden uygulama kapanana kadar kalıcıydı). Kimse seste değilken ağ adresleri değişmişse (Hamachi sonradan bağlandı) ses sunucusu yeni adreslerle yeniden başlar. **Hamachi kopması (2026-11-07 `host.log`):** arkadaşın Hamachi üzerinden rtc ile sese katılmasından hep ~15 sn sonra ana WS `1006` ile düşüyor (host 15 sn hiçbir şey alamayınca kesiyor) → yeniden bağlan → yeniden katıl döngüsü; tünelden (ws) stabil. Yani WebRTC medyası başlayınca o makinenin Hamachi yolu tamamen tıkanıyor (muhtemelen Hamachi röle/bant sınırı veya UDP'ye takılan bir şey; kesin değil). Önlem: rtc oturumu başladıktan sonraki 60 sn içinde soket 2 kez düşerse o arama WS medyasına geçer ve kullanıcıya bildirilir (tünel açıksa "Tünel moduna geç" önerilir). Host artık her taşıma için seçilen ICE çiftini (`… media via udp 25.x:47821 <-> …`) ve "15 sn hiçbir şey alınmadı" düşüşünü loglar. mediasoup işçisi çökerse istemcilere `voice.ended {reason:"error"}` gider ve otomatik yeniden katılırlar (önceden sessizce düşürülüyordu → host "bağlı" görünüp odada değildi; 2026-11-07 Hamachi olayının muhtemel nedeni, kesin kanıt için artık `host.log` var).
13. Global bas-konuş ve **mikrofon aç/kapat kısayolu** (Ayarlar → Ses, `nx.voice.muteKey`, ör. `Ctrl+Shift+KeyM`, `F9`, `Mouse4`) `GetAsyncKeyState` ile 15 ms'de bir yoklanır (yalnızca sesteyken) → oyun öndeyken de çalışır (`media:setHotkeys`). Değiştiricisiz harf kısayolu, NooXCord'da yazı alanı odaktayken tetiklenmez. Fare orta/yan tuşu kısayolda seçilebilir; bas-konuş ayarında henüz değil. Yönetici olarak çalışan oyunlarda tuş okunamayabilir.
14. Tünel modu (NXM-WS) sınırları: tünelden giren ekran yayını ≤720p / 15 fps açar, ses tarayıcı veriyorsa Opus ile gider (§6.6), kamera açabilir (§6.5) — ikisi de WebCodecs `VideoEncoder` ister; yayının hangi simulcast katmanıyla tünelden izleyenlere gideceğini **yayıncı seçer** (Paylaş penceresi + kendi yayın kartı, `stream.tunnelQuality`, `StreamInfo.tunnelHigh`; varsayılan Düşük). Yüksek seçiliyken soketi yetişmeyen izleyici 20 sn düşük katmana iner, sonra tekrar dener; mikrofon için tarayıcıda WebCodecs `AudioEncoder` gerekir (yoksa yalnızca dinleme).
15. ~~Ana süreç metinleri~~ → Faz 4'te `main.*` anahtarlarına taşındı (ana süreç `tr.json`/`en.json`'u derleme anında paketler, dil renderer ayarını izler). **Kalan:** host'un döndürdüğü hata mesajları (`fail(...)`) Türkçe; İngilizce arayüzde de Türkçe görünür → hata kodu + anahtar ile çevrilmeli.
16. Tünel açılışta otomatik başlamaz (bilinçli: herkese açık bağlantı kullanıcı istemeden açılmasın); her seferinde Ayarlar → Bağlantı'dan açılır.
17. Uzaktan kontrol: panik kısayolu sabit (`Ctrl+Alt+Shift+Esc`), ek engellenecek kombinasyon ayarı yok (yalnızca Win tuşları engelli) — ayar ekranı sonraya. Yönetici yetkili pencereler girdi almaz (UIPI), istek kartında yazıyor.
18. Auto-update: herkese açık repo `github.com/nightcrewlab/NooXCord`, `electron-builder.yml` `publish: github`. Sürüm çıkarmak: `apps/desktop/package.json` sürümünü artır → `pnpm dist` → `gh release create vX.Y.Z release/NooXCord-Setup-X.Y.Z.exe release/NooXCord-Setup-X.Y.Z.exe.blockmap release/latest.yml` (taslak/ön sürüm değil). Kurulu uygulama açılıştan 15 sn sonra ve 6 saatte bir bakar, indirir, çıkışta kurar. İndirme ilerlemesi ve "Yeniden başlat ve kur" sağ üst köşede kartla da gösterilir (`features/updates/UpdatePopup.tsx`, kapatılınca o aşama için gizlenir). 0.5.0 beslemesiz derlendi; 0.5.1–0.5.2 güncelleyicisi bozuktu (`import("electron-updater")` adlandırılmış `autoUpdater`'ı görmüyor → `.default` üzerinden alınıyor) → 0.5.3 bir kez elle kurulmalı. Geliştirme `electron.exe` çalıştırmaları ayrı AUMID (`com.nooxrii.nooxcord.dev`) kullanır: aynı ID, Windows görev çubuğunda kurulu uygulamaya Electron simgesini önbellekletmişti.
19. Yedekler yalnızca veritabanını kapsar (`%APPDATA%/NooXCord/host/backups`), yüklenen dosyalar dahil değil.
20. Migration 2 `channels` tablosunu yeniden kurar (DM için `guild_id` boş olabilir); migration sırasında foreign key kapalı, sonra `foreign_key_check`. Eski şema dosyası önce `backups/…-v1.db` olarak kopyalanır.
21. Okunmamış işareti: DM'ler `markRead`'de hiç okunmuş sayılmıyordu (yalnızca guild kanalları aranıyordu) ve pencere arka plandayken gelen mesajlar pencere öne gelince okunmuyordu → ikisi de düzeltildi (Faz 5 başı).
22. iPhone Safari'de yalnızca `<video>` tam ekran olabilir: yayın döşemesi önce element tam ekranını, sonra `webkitEnterFullscreen`, en son CSS ile pencereyi kaplamayı dener.
23. **2026-11-09:** Hamachi'de rtc başladıktan sonraki ilk kopmada (önceden 2.) arama WebRTC'den çıkar: masaüstünde tünel açıksa otomatik tünele geçer (`switchToTunnel`, `engine.ts`), yoksa WS medyası. Log'a göre kopmada host istemciden hiçbir şey alamıyor ama istemci host'tan alıyor (yukarı yön tıkanıyor) → istemci 7 sn pong alamazsa soketi kendisi yeniler (`connection.ts`, önceden host'un 15 sn'sini bekliyordu). Kök neden kesin değil (Hamachi röle modu şüpheli).
24. Ses kırçıllanması önlemleri (2026-11-09): mediasoup işçisi + host süreci `ABOVE_NORMAL` öncelik (oyun açıkken herkesin sesi host'tan geçiyor), `disable-renderer-backgrounding` (gizli/küçültülmüş pencerede renderer arka plan önceliğine düşmesin), mikrofon/yayın sesi `priority/networkPriority: high`, alınan seste `jitterBufferTarget` 80 ms (yayın sesi 120). Gerçek oyun + yayın altında doğrulanmadı.
25. Telefon tarayıcısında arka plan (`media/background.ts`): Audio Session `play-and-record`, sessiz döngü `<audio>`, Media Session (kapat/mikrofon), öne gelince AudioContext devam + bitmiş mikrofonu yeniden aç. iOS arka planda mikrofonu yine de susturabilir; garanti değil. Yayın döşemesinde **mini oynatıcı (PiP)** düğmesi (standart API veya Safari `webkitSetPresentationMode`). Ses kanalı bildirim sesleri: `features/voice/sounds.ts` (katıl/ayrıl/sustur/sağırlaştır, Ayarlar → Ses'ten kapatılabilir). Görev çubuğu simgesi: Windows simge önbelleği exe yolu için eski Electron simgesini tutuyordu → `setAppDetails` ve kısayollar `resources/icon.ico`'yu gösterir, sürüm başına bir kez `ie4uinit -show`.
26. **2026-11-09 tünel sesi + arama süresi:** Tünel sesi worklet'ten doğrudan hoparlöre gider (MediaStream turu yok), mikrofon kendi bağlamında (`micContext`) yakalanır. Çalma tamponu kendini ayarlar (120 → en fazla 300 ms, 20 sn sakinlikte küçülür, fazlası atlanır); kesilme sayısı + tampon ses çubuğunda gösterilir (`audioDiag`). Host tünel izleyicisinin soket birikimini süreyle sınırlar (görüntü 0,4 sn, ses 1,2 sn, ölçülen hızla). Uzun izlemede (~10 dk) telefonda kırçıllanma yine de görüldü → büyük olasılıkla Cloudflare tüneli; açık. iPhone'da arka plandan dönünce izlenen yayınlar yeniden açılır (`rewatchAll`). Sesli kanalda arama süresi sayacı: host `VoiceState.callSince` (oda boşalıp 30 sn içinde dolarsa korunur).
27. **2026-11-10 Hamachi kopmasının nedeni (host.log ile eşleşti):** her kopma, arkadaşın istemcisinin host'a ilk büyük WS mesajını (`media.consume` içindeki ~10 KB `rtpCapabilities`) gönderdiği anda başlıyor (ör. 14:07:10 host sese katıldı → 14:07:11 son paket → 15 sn sonra düşüş; yalnız başına sesteyken sorun yok, tünel/WS medyasında bu mesaj küçük olduğu için sorun yok). Hamachi bağdaştırıcısı MTU 1404; tam boy TCP parçaları host yönünde kayboluyor, TCP aynı parçayı yeniden gönderirken ping'ler de arkasında bekliyor. **Çözüm:** istemci 900 karakterden uzun çerçeveleri `~0…`/`~1…` parçalarına böler (`PART_SIZE`, `connection.ts` `sendText`; host `index.ts`'de birleştirir, `HostInfo.parts` ile duyurur → eski host'a parçalanmadan gider). Gerçek Hamachi'de arkadaşla doğrulanmadı ⏳. Kapsam dışı: Hamachi üzerinden HTTP dosya yüklemesi ve WS medyasında görüntü gönderimi yine tam boy parça kullanır (TCP kendi kendine toparlayabilir, yavaş olabilir). Aynı gün: gizli pencerede zamanlayıcı dakikada bire düşünce `stale-up` denetimi sağlam soketi her dakika kapatıp kullanıcıyı sesten düşürüyordu (`disconnected (4000)` satırları) → artık cevapsız ping'in yaşına bakılıyor; değiştirilen bağlantının geç gelen `closed` durumu yenisinin durumunu ezmiyor; bağlantı hazır olmadan açılan kanalın mesajları hazır olunca yükleniyor.
28. **2026-11-21 host'un kendi yayını izleyicilerde donuyordu:** host'un istemcisi medyayı kendi makinesine gönderiyor (`25.x <-> 25.x`), yani yayıncı tarafında bant sınırı yok → hep tam bitrate; Hamachi'deki izleyiciye katman geçişinde gereken büyük anahtar kare kaybolunca görüntü kalıyordu (izleyici kendi yayınını açınca upload'u bitrate'i sınırladığı için donmuyordu). Kesin değil. Önlem: izleyicide donma bekçisi (`guardFreeze`, paket gelip kare çözülmüyorsa `media.keyFrame`, 3 denemeden sonra consumer'ı yeniden açar); host her izleyicinin aldığı katmanı (`[stream] X <- Y layer …`, `none (bandwidth)`) ve beklenmeyen RPC hatalarını (`[rpc] … failed`) `host.log`'a yazar. Gerçek Hamachi'de doğrulanmadı ⏳. Aynı gün: "Sistem varsayılanı" mikrofon seçiliyken Windows varsayılanı değişince (yeni mikrofon takıldı) mikrofon `devicechange` ile yeniden açılır (`followDefaultMic`).
29. **2026-11-23 yayıncı NooXCord odakta değilken yayın donuyor, odaklanınca geliyor + boşta ~2 GB bellek:** kök neden kesin değil (arka plan kısıtlaması seste zaten kapalı, `media:setInCall`). Önlem: seste iken renderer, GPU süreci ve Chromium'un ekran yakalama / ses servisleri `ABOVE_NORMAL` öncelikte (`media.ts` `startCallBoost`, 15 sn'de bir yeniden uygulanır, sesten çıkınca `NORMAL`). Teşhis: yayın sırasında `main.log`'a `[share]` satırları (yakalama fps, katman başına kodlanan fps, kodlayıcı, `qualityLimitationReason`, anahtar kare isteği, odak/görünürlük; durum değişince veya dakikada bir; `STALLED` = tüm katmanlar < 2 fps) ve `[memory]` satırları (`services.ts` `startMemoryWatch`: 30 dk'da bir süreç türü başına özel bellek, her 512 MB eşiğinde tam döküm; mediasoup-worker dahil değil). Bir sonraki donma/şişmede bu satırlara bakılacak ⏳.
30. **P2P mesh sınırı:** yayıncı her izleyici için ayrı kodlar ve gönderir (upload × izleyici). ~6 kişiden kalabalık ses veya 4'ten fazla izleyicili yayın zorlanır; gerekirse ileride bir SFU (ör. kendi PC'de isteğe bağlı) geri eklenebilir.
31. **NAT:** simetrik NAT / mobil CGNAT'ta STUN yetmez → TURN gerekir (`CLOUDFLARE_TURN_*` veya `TURN_*`). Ayarlanmadıysa o kişiyle bağlantı "failed" kalır ve uyarı çıkar. Gerçek iki ağ testi ⏳.
32. **Turso yansıtma:** yazmalar asenkron gider; sunucu çökerse son birkaç yüz ms kaybolabilir. Ağ hatasında artan aralıkla yeniden dener; SQL hatası veren grup atlanıp loglanır (yerel ile Turso ayrışabilir → bir sonraki açılışta Turso esas alınır). Turso'da NooXCord şeması olmayan dolu bir veritabanı reddedilir.
33. **Render uykusu:** 15 dk trafiksiz kalınca uyur; ilk bağlanan ~1 dk bekler. Uyanırken yerel dosya Turso'dan yeniden kurulur (veri büyüdükçe açılış uzar; dosyalar dahil).
34. **IP görünürlüğü:** P2P'de kanaldaki kişiler birbirinin IP adresini görür. İstenirse yalnızca TURN (`iceTransportPolicy: "relay"`) seçeneği eklenebilir.
