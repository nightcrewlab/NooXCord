# ADR 0001 — Tünel sağlayıcısı

**Durum:** Kabul edildi (2026-11-05) · **Karar veren:** NooXRii

## Bağlam
Uygulamayı kurmamış kişilerin (telefon dahil) tarayıcıdan, port açmadan bağlanabilmesi gerekiyor. İlk planda yalnızca Microsoft Dev Tunnels vardı. Kullanıcı, daha iyi bir seçenek varsa ona geçilebileceğini, sabit URL'nin şart olmadığını söyledi (URL kopyalama kısayolu yeterli).

## Değerlendirilen seçenekler
| | Microsoft Dev Tunnels | **Cloudflare Quick Tunnel** | ngrok (ücretsiz) | playit.gg |
|---|---|---|---|---|
| Hesap | GitHub/Microsoft girişi | **Gerekmez** | Gerekir | Gerekir |
| URL | Sabit (tünel ID'si) | Her başlatmada yeni `*.trycloudflare.com` | 1 sabit alan adı | Sabit |
| Tarayıcı uyarı sayfası | Var (ilk girişte, anonimde) | **Yok** | Var | — |
| Trafik limiti | Var (aylık bant genişliği limiti bildirildi) | Belirtilmiş bir bant limiti yok; 200 eşzamanlı istek sınırı | 1 GB/ay → yayın için yetersiz | Var |
| Protokol | HTTPS/WS | HTTPS/WS (SSE yok) | HTTPS/WS (TCP kart doğrulamalı) | TCP + **UDP**, HTTPS yok |
| Paketleme | CLI'yi ilk kullanımda indir (yeniden dağıtım lisansı belirsiz) | `cloudflared` Apache-2.0 → **installer'a gömülebilir** | Kapalı kaynak ajan | Ayrı ajan |

## Karar
`TunnelProvider` arayüzü ile **iki sağlayıcı**:
1. **Cloudflare Quick Tunnel (varsayılan):** Sıfır kurulum, hesap yok, uyarı sayfası yok. `cloudflared.exe` installer ile gelir. URL her açılışta değişir → ayarlarda ve üst çubukta **"URL'yi kopyala"** butonu, global kısayol (varsayılan `Ctrl+Shift+L`), QR kod ve "URL değişti" bildirimi.
2. **Microsoft Dev Tunnels (isteğe bağlı):** Sabit URL isteyenler için; GitHub ile bir kez giriş, "Yeni URL oluştur" ile yenileme.

İkisi de yalnızca HTTPS/WebSocket taşır; bu yüzden tünelden gelen istemciler için medya **WebSocket üzerinden** (NXM-WS, bkz. ADR 0002 / P2) akar. UDP gerektiren doğrudan WebRTC yolu LAN, Hamachi veya açık port ile kullanılır. playit.gg (UDP) ileride düşük gecikmeli bir 3. sağlayıcı olarak eklenebilir; adapter arayüzü buna izin verecek şekilde tutulur.

## Riskler
- Quick Tunnel'lar Cloudflare tarafından "test ve geliştirme amaçlı" olarak tanımlanıyor; hizmet garantisi yok. Kesilirse uygulama otomatik yeniden başlatır ve yeni URL'yi bildirir.
- WebSocket boşta kalınca Cloudflare bağlantıyı kapatır → istemci 2 sn'de bir ping atar (P2'de uygulandı).
- Yoğun video trafiğinin Cloudflare'in ücretsiz plan şartlarıyla uyumu takip edilmeli; tünel modunda varsayılan yayın kalitesi düşük tutulur.
