# NooXCord

Sesli/görüntülü sohbet ve ekran paylaşımı uygulaması (Windows 10 2004+ / Windows 11 masaüstü + tarayıcı, telefon dahil). Sunucu Render.com'da sürekli açık durur, veriler Turso'da saklanır; ses, kamera ve yayınlar kişiler arasında doğrudan (P2P) gider.

## Kurulum

1. `NooXCord-Setup-x.y.z.exe` dosyasını çalıştır. Kurulum kullanıcı başınadır, yönetici izni istemez.
2. Kurulum dosyası henüz kod imzalı değil. Windows SmartScreen **"Windows bilgisayarınızı korudu"** uyarısı gösterirse **Ek bilgi → Yine de çalıştır**'a tıkla.

Kaldırırken kullanıcı verilerinin (`%APPDATA%\NooXCord`: oturumlar, ayarlar, kayıtlar) silinip silinmeyeceği sorulur.

## Sunucu (Render.com + Turso)

`render.yaml` bir Render Blueprint'idir: Render → **New → Blueprint** → bu depo. Ortam değişkenleri:

| Değişken | Gerekli | Açıklama |
|---|---|---|
| `TURSO_DATABASE_URL` | evet | `libsql://<veritabanı>-<kuruluş>.turso.io` |
| `TURSO_AUTH_TOKEN` | evet | Turso veritabanı token'ı |
| `NX_GUEST_PASSWORD` | hayır | Tarayıcı misafirlerinin girmesi gereken şifre |
| `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN` | hayır | Doğrudan bağlanamayanlar için TURN aktarıcısı |

Masaüstü uygulamasının varsayılan sunucusu derlemede `VITE_NX_DEFAULT_HOST` ile verilir (ör. `https://nooxcord.onrender.com`).

## Geliştirme

Gerekenler: Node.js 22.13+, pnpm 9, Rust (stable, MSVC), Visual Studio Build Tools (C++).

```bash
pnpm install
pnpm build:native   # Rust native modül
pnpm dev:host       # sunucu (yerel veritabanı) → http://localhost:47820
pnpm dev            # Electron + Vite
pnpm test           # sunucu testleri
pnpm test:voice     # 3 kişilik P2P ses/yayın testi
pnpm dist           # release/NooXCord-Setup-<sürüm>.exe
```

Ayrıntılar: `CLAUDE.md`, `docs/adr/0003-render-turso-p2p.md`.
