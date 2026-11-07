# NooXCord

Kendi bilgisayarında barındırdığın sesli/görüntülü sohbet ve ekran paylaşımı uygulaması (Windows 10 2004+ / Windows 11). Arkadaşların masaüstü uygulamasıyla ya da tarayıcıdan (telefon dahil) bağlanır.

## Kurulum

1. `NooXCord-Setup-x.y.z.exe` dosyasını çalıştır. Kurulum kullanıcı başınadır, yönetici izni istemez.
2. Kurulum dosyası henüz kod imzalı değil. Windows SmartScreen **"Windows bilgisayarınızı korudu"** uyarısı gösterirse **Ek bilgi → Yine de çalıştır**'a tıkla.
3. Sunucu barındıracaksan: **Ayarlar → Bağlantı → Windows Güvenlik Duvarı → İzin ver** (yönetici onayı ister; yalnızca özel ağlar için kural ekler). Windows ilk açılışta kendisi de sorabilir.

Kaldırırken kullanıcı verilerinin (`%APPDATA%\NooXCord`: oturumlar, ayarlar, barındırılan sunucunun veritabanı ve yedekleri) silinip silinmeyeceği sorulur.

## Geliştirme

Gerekenler: Node.js 22+, pnpm 9, Rust (stable, MSVC), Visual Studio Build Tools (C++).

```bash
pnpm install
pnpm build:native   # Rust native modül
pnpm dev            # Electron + Vite
pnpm test           # host testleri
pnpm dist           # release/NooXCord-Setup-<sürüm>.exe
```

`pnpm dist` için `.tools/cloudflared.exe` gerekir. Ayrıntılar: `CLAUDE.md`.
