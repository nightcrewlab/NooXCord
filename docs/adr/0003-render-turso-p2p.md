# ADR 0003 — Render + Turso + P2P medya

- **Tarih:** 2026-11-23
- **Durum:** Kabul edildi (NooXRii)
- **Yerine geçtiği:** §2.1 "Medya (SFU)" ve §2.2 süreç modelindeki yerel host, ADR 0001 (tünel sağlayıcıları)

## Bağlam
Host kullanıcının kendi PC'sinde çalışıyordu: PC kapalıyken sunucu da kapalıydı. Sürekli açık ücretsiz bir
sunucu istendi. Oracle Always Free Türk banka kartlarını kabul etmiyor. Render.com'un ücretsiz web servisi
kart istemiyor ama: 15 dk trafiksiz kalınca uyur (~1 dk uyanma), disk kalıcı değil, 512 MB RAM / 0.1 CPU,
dışarıya yalnızca HTTP(S)/WebSocket açar (UDP yok), aylık trafik birkaç GB.

## Karar
1. **Sunucu Render'da** (tek web servisi): REST + WebSocket (sohbet, sinyal), derlenmiş web istemcisini de sunar.
   Sabit HTTPS adresi → telefondan mikrofon/kamera doğrudan çalışır, tünel gerekmez.
2. **Veritabanı Turso** (libSQL, SQLite uyumlu): sunucu çalışırken yerel `node:sqlite` dosyası kullanılır
   (mevcut senkron kod değişmez); her yazma (tek komut veya bir transaction) sırayla Turso'ya da gönderilir
   (`db.ts` yansıtma). Açılışta yerel dosya Turso'dan doldurulur; migration çalışırsa şema + veri bütün
   olarak Turso'ya yazılır. Turso tanımlı değilse (geliştirme, testler) yalnızca yerel dosya.
3. **Yüklenen dosyalar veritabanında** (`blobs` tablosu) — Render diski kalıcı değil. Yükleme sınırı 8 MB
   (Turso istek boyutu ve Render trafiği).
4. **Medya P2P (mesh WebRTC):** kanaldaki her kişi çifti arasında bir `RTCPeerConnection`. Sunucu medyaya
   dokunmaz; yalnızca `rtc.signal` mesajlarını aynı kanaldaki kişiler arasında aktarır. ICE: STUN (Google /
   Cloudflare) + isteğe bağlı TURN (sunucu ortam değişkenleri, `voice.join` ile istemciye verilir).
   - Her bağlantıda sabit 4 transceiver: mikrofon, kamera, ekran, ekran sesi. Teklifi küçük `userId`'li
     taraf verir; parçalar `replaceTrack` ile değiştirilir → yeniden müzakere gerekmez.
   - Mikrofon ve kamera herkese; ekran ve ekran sesi yalnızca yayının izleyicilerine (yayıncı, sunucunun
     yaydığı `StreamInfo.viewers` listesine göre gönderir).
   - Ekran codec'i H.264 öncelikli (her yerde donanım kodlama/çözme), sonra VP8; kişi başına ayrı kodlama.
5. **Masaüstü uygulaması yalnızca istemci:** yerel host (utilityProcess), mediasoup, cloudflared, Dev Tunnels,
   Hamachi, port kontrolü, güvenlik duvarı ve DB yedekleme kaldırılır. Uzaktan kontrol, overlay, sistem
   sesi (WASAPI), bas-konuş, tepsi, güncelleme aynen kalır.

## Sonuçlar
- \+ Sunucu PC'den bağımsız; sabit adres; tünel/Hamachi/port derdi yok; ücretsiz.
- \+ Sunucu medyayı taşımadığı için Render'ın CPU/trafik sınırı ses/yayın için sorun değil.
- − Mesh: yayıncının upload'u ve kodlama yükü izleyici sayısıyla çarpılır → pratik sınır ses ~6 kişi,
  yayın 2–4 izleyici.
- − Simetrik NAT / CGNAT (mobil hatlar) TURN olmadan bağlanamayabilir.
- − Kişiler birbirinin IP adresini görür (P2P). İstenirse yalnızca TURN (`iceTransportPolicy: relay`).
- − Kimse bağlı değilken sunucu uyur, ilk giren ~1 dk bekler.
- − Turso'ya yazma asenkron: sunucu çökerse son birkaç yüz ms'lik yazma kaybolabilir.
- − AV1/VP9 ve simulcast kalktı (kişi başı kodlamada gerek yok); kalite/bitrate dengesi H.264 ile.
