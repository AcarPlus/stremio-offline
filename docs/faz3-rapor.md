# Faz 3 raporu — Stremio bağlantısı

Tarih: 2026-11-14. Sınama: ayrı veri klasörü ve ayrı indirme klasörüyle (OFFLINE_DATA_DIR / OFFLINE_DOWNLOAD_DIR, rqbit 11492) 11480'de çalışan servis, Stremio 5 (WebView2) hata ayıklama kapısı 11481. İçerik: Sintel (YTS 720p, 136 MB).

## Gömme denemesi
**Olumlu.** `web.stremio.com` CSP ya da `X-Frame-Options` göndermiyor; `http://127.0.0.1:11480/?embed=1#/…` iframe'i yüklendi (karışık içerik engeli yok, 127.0.0.1 güvenilir sayılıyor), sayfa içinden `/api/*` istekleri çalıştı, `location.ancestorOrigins[0]` = `https://web.stremio.com`. İframe ayrı süreçte (CDP'de ayrı `iframe` hedefi). Ayrı pencere yedeği kodda duruyor: iframe 10 sn içinde yüklenmezse kapanır, İndirme Merkezi `window.open` ile açılır ve uyarı gösterilir.

## DOM çapaları
Sınıf adları hiçbir yerde tam yazılmaz; `classHas(sınıf, kök)` sınıfın anlamlı kökünü ya da `kök-<4–8 karakter ek>` biçimini arar (ör. `action-buttons-container-XbKVa`).

| Ne | Çapa |
|---|---|
| Sayfa türü | adres: `#/detail/<movie|series>/<tt>[/<video>][?season=N]`, `#/player/…` |
| "İndir" / "Sezonu indir" | görünen sayfadaki `action-buttons-container` (sona eklenir) |
| "Offline oynat" | görünen sayfadaki `meta-info-container` (en başa) |
| Sezon (adreste yoksa) | `seasons-bar` metni ("Sezon 2" / "Season 2") |
| Poster rozeti | `a[href^="#/detail/"]` içindeki ilk `img`'nin üst öğesi |
| Akış menüsü (eski) | `[class*="context-menu-content-"]`, `a[href*="#/player/"]` |
| Kart menüsü (eski) | `[role="menu"]`, `[data-value="details"]`, `button[aria-expanded="true"]` |

Stremio önceki sayfaları `display:none` ile DOM'da tutuyor; bu yüzden yalnızca görünen (`getClientRects().length > 0`) çapa kullanılır, gizli sayfada kalan düğmeler kaldırılır (ilk sürümde düğmeler gizli sayfaya ekleniyordu, canlı denemede yakalandı).

Yapı değişirse: film/dizi sayfasında 8 sn içinde düğme yeri bulunamazsa düğmeler sağ üstte sabit yedek kutuya konur; ana ekran/keşif/kütüphanede çok görsel olup hiç kart bağlantısı yoksa ya da akışa sağ tıklanıp menü çıkmazsa uyarı verilir. Her uyarı bir kez `console.warn` ve sol altta kapatılabilir küçük kutu. Tanılama: `window.__offlineIndirDurum()`.

## Oynatma
İndirme Merkezi'nin `oynat` iletisi (köken = servis, `source: 'offline-indir'`, `playUrl` servisin `/play/` adresi olmalı) ve "Offline oynat" aynı yolu kullanır: akış `{url: playUrl, behaviorHints}` → base64(zlib(JSON)) → `#/player/<akış>/<servis manifest>/<servis manifest>/<tür>/<tt>/<video>`. Meta da servisten gelir (kütüphanedekiler için internetsiz). Servise yeni uç gerekmedi.

## Stremio içinde denenenler (hepsi geçti)
- İframe gömme, "İndir" → sürüm seçici gömülü pencere (ekran görüntüsü alındı), oradan Sintel indirildi.
- "Kapat" iletisi pencereyi kapatıyor.
- Dizi sayfası (`?season=2`) → "Sezonu indir" → `#/sezon/tt0903747/2` açıldı (indirme yapılmadı).
- Keşif'te servis kataloğunda Sintel posterinde "✓ Offline" rozeti.
- Film sayfasının en üstünde "▶ Offline oynat"; tıklayınca Stremio oynatıcısı açıldı, libmpv dosyayı servisin `/play` ucundan (diskten) istedi. Birkaç saniye sonra geri dönüldü.
- İndirilenler'de "▶ Oynat" → `oynat` iletisi → pencere kapandı, aynı oynatıcı adresi açıldı.
- Eski akış sağ tık menüsünde "Cihaza indir (offline)" görünüyor (tıklanmadı).
- Yapı uyarısı: düğme yerinin sınıfı bozularak benzetildi → uyarı kutusu + yedek konumda "İndir".

## Denenmeyenler / bilinen kusurlar
- İnternetsiz açılış (Faz 4), kart üç nokta menüsü (menü açılmadı), ana ekran ve kütüphanede rozet (Sintel o listelerde yoktu; aynı kod keşifte çalıştı), "İniyor %x" rozeti canlı görülmedi (birim sınamasında var).
- Sayfa yüklenirken servis yeniden başlarsa yeni `inject.js` ancak Stremio sayfası yenilenince devreye girer (eski koruma bayrağı).
- **Dikkat:** Sınama sırasında sınama servisine benim yapmadığım eklemeler geldi (The Mentalist S01E14, Weapons, The Witch) ve Weapons'ı bir başkası sildi; ana ekran yüklendiği anlara denk geliyordu. Kaynağı belirlenemedi (Stremio'nun kendisi mi, kullanıcı mı). Benim iptal ettiklerim yalnızca sınama klasöründeydi; gerçek `data/` ve indirme klasörüne dokunulmadı. Kullanıcıya sorulmalı.
