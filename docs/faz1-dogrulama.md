# Faz 1 doğrulama raporu

Doğrulanan commit: `9ac6b56`. Temiz bir git worktree'sinde, ayrı veri/indirme klasörleri ve 11580–11599 aralığındaki kapılarla, gerçek ağda (Sintel, Torrentio, Cinemeta) denendi. Ürün koduna dokunulmadı. Stremio penceresi ve gerçek `data/` klasörü kullanılmadı (hepsinde `OFFLINE_NO_INJECT=1`).

## Kontrol sonuçları

| # | Kontrol | Sonuç | Kanıt |
|---|---|---|---|
| 1 | `npm test` temiz worktree'de | geçti | 17/17 başarılı, iki çalıştırma da ~68,5 sn; dalgalanma yok. |
| 2 | Sintel ile uçtan uca (yalnız mp4, duraklat, sürdür, Range, tamamlanma, sil) | geçti | Yalnız dosya 5 seçildi. Duraklatınca 16.650.904 bayt 4 sn boyunca sabit kaldı; sürdürünce ilerledi. `Range: bytes=100000000-100065535` 206 döndü (ilk bayt 17,6 sn sürdü). Tamamlanınca motor `paused`, `finished=true`, `uploaded_bytes=0`; diskte 129.241.752 bayt. `DELETE` sonrası dosya, klasör, .torrent önbelleği ve motor kaydı yok. Ayrıca kısmen inmiş öğede `cancel` ve `DELETE` dosyaları sildi. (Not: ilk silme denemem büyük harfli anahtarla yapıldığı için K3 kusurunu ortaya çıkardı.) |
| 3a | rqbit alt sürecini öldür | geçti | Servis 1 sn içinde yeniden başlattı (`restarts: 1`), öğe `downloading` kaldı, ilerleme sürdü. |
| 3b | Servisi sert öldür, yeniden başlat | geçti | Yeniden açılışta öğe `downloading`, 23,07 MB'tan 23,34 MB'a devam etti; baştan inmedi. |
| 3c | Geride kalan rqbit'in açılışta temizlenmesi | kısmen denendi | Doğal durum üretilemedi: bu ortamda servis öldürülünce rqbit de onunla ölüyor. Elle başlatılmış, pid dosyası gösterilen bir rqbit ile denendi: açılışta "önceki çalışmadan kalan rqbit kapatıldı" yazıldı, yenisi aynı kapıda açıldı. |
| 3d | Sahte infoHash (DHT açık) | geçti | 90 sn sonra öğe `error`: "Torrent bilgisi 90 sn içinde alınamadı…"; servis yanıt vermeye devam etti, motorda kayıt kalmadı. |
| 3e | Bozuk istekler | geçti (kusurlarla) | Geçersiz JSON, `null`/`[]` gövde, bozuk URL kodlaması, 100 KB yol, rastgele bayt, bozuk chunked, geçersiz Range başlıkları, 3 MB gövde: süreç çökmedi, günlükte yakalanmamış hata yok. Ama K5 ve K6 kusurları görüldü. |
| 4 | Eski kütüphanenin taşınması | geçti | Gerçek `library.json` kopyası (özgün dosyanın özeti öncesi/sonrası aynı) ile: 2 kayıt taşındı, `library.v1.json` yedeği oluştu. Büyük (~49 GB) yarım kayıt `paused`, motor listesi boş, `active: 0`, 15 sn sonra da hiçbir şey inmedi. Tamamlanmış küçük kayıt `completed` ve diskten oynatıldı. |
| 5 | Eklenti uçları ve eski uçlar | geçti | `manifest.json`, film ve dizi bölümü `stream`, `catalog`, kütüphanedeki öğe için `meta` (kütüphanede olmayan için 404), `logo.svg`, `/` doğru. `POST /api/auto` ve `POST /api/download`: ilk çağrı "İndirme başladı", ikincisi "Zaten iniyor", duraklatılmışsa "İndirme sürdürüldü", geçersiz hash için 400. |
| 6 | Torrentio katmanı | kaldı (tek madde) | Film (Sintel, 32 sürüm): kalite, boyut, seeder, kaynak ve dil sayısı ham Torrentio çıktısıyla 32/32 aynı, seeder'a göre azalan. Dizi (Breaking Bad S01 e2, 260 sürüm) 260/260 aynı. Sezon: 7 bölüm, 242 paket, bölüm başına seçenekler ham sonuçla aynı, RARBG paketi için paket (7 bölüm, 5,80 GB, dosya numaraları) ile `/api/torrents/:id/files` sonucu birebir. Kalan: tek sezonluk "COMPLETE" paketleri `multiSeason: true` işaretleniyor (K2). |
| 7 | `docs/api.md` ile gerçek | geçti (kusurlarla) | Belgelenen tüm uçlar var ve anahtarlar belgedeki gibi: `status`, `items`, `items/:id`, `POST items` (201/200), `pause`, `resume`, `cancel`, `DELETE` ve `POST …/delete`, `?keepFiles=1`, `files` (400/409 durumları dahil), `versions`, `season`, `torrents/:id/files`, `play` (HEAD, 206, 416), eski uçlar. Belgedeki 413 davranışı gerçekte yok (K5). |
| 8 | Repo hijyeni | geçti | İzlenen dosyalarda kullanıcı adı, e-posta ve kullanıcı klasörü yolu kalıplarının hiçbiri bulunmadı. Tek not: commit yazar adı bir GitHub kullanıcı adı ve noreply adresi içeriyor (dosya içeriği değil, geçmiş meta verisi). |
| 9 | `lib/` taraması | geçti (kusurlarla) | Yakalanmamış reddedilme yok (zamanlayıcılar ve `activate` içeride yakalıyor). Silme yolları `inside()` ile kısıtlı; `C:/tmp/dl-evil`, `..`, başka sürücü, büyük/küçük harf denendi, doğru. Kusurlar aşağıda. |

## Kusur listesi (önem sırasıyla)

**K1 (orta) — `/play` yan etkili ve köken denetimsiz; Host başlığı doğrulanmıyor.**
`server.mjs:87` civarı: `GET /play/:type/:id/:infoHash/:idx` bilinmeyen hash için kütüphane öğesi oluşturup indirmeyi başlatır ve CORS `*` ile her kökene açıktır. Ziyaret edilen herhangi bir web sayfası (`<img src=…>`) kullanıcının servisine istediği torrenti ekleyebilir (disk doldurma, istenmeyen içerik). Sınama: `Origin: https://evil.example` ile istek, öğe `resolving` olarak oluştu. Aynı şekilde `Host: evil.example` ile `/api/status` 200 döndü (DNS yeniden bağlama). Öneri: `/play` içinde öğe oluşturmayı yalnızca kökensiz ya da `https://web.stremio.com` kökenli isteklerde yap, diğerlerinde 403 dön; tüm isteklerde `Host` başlığı `127.0.0.1:port`/`localhost:port` değilse 403.

**K2 (düşük-orta) — `multiSeason` yanlış bayrak, düzeltme uygulanmamış.**
`lib/torrentio.mjs:149` kendi regex'ini kullanıyor ve `complete|komple|tüm sezon` içeriyor; commit `83b4933` bu durumu düzelttiğini söylüyor ama düzeltilen `MULTI_SEASON` (satır 10) hiçbir yerde kullanılmıyor. Yeniden üretme: `GET /api/season?id=tt0903747&season=1`; "Breaking.Bad.SEASON.01.S01.COMPLETE.1080p…" gibi tek sezonluk paketler `multiSeason: true`. Öneri: satır 149'da `MULTI_SEASON.test(x.name)` kullan.

**K3 (düşük) — Büyük harfli anahtarla silme hayalet kayıt bırakıyor.**
`lib/api.mjs:147` `key`'i küçültmüyor; `lib/manager.mjs:374` `this.lib.delete(ih)` ham anahtarla çağrılıyor, `lib/library.mjs:105` `delete` normalleştirmiyor. `POST /api/delete?key=<HASH_BÜYÜK_HARF>` `{ok:true}` döndü, dosyalar silindi ama öğe `completed` olarak listede kaldı. Öneri: `Library.delete` içinde `String(ih).toLowerCase()` kullan (ve `api.mjs:147`'de küçült).

**K4 (düşük) — Cinemeta geçici hatasında `/api/season` yeniden denemiyor.**
`lib/torrentio.mjs:120` + `lib/meta.mjs` (9 sn zaman aşımı): Cinemeta'dan gelen aralıklı `ECONNRESET` ile art arda iki çağrı "Dizi bilgisi alınamadı" (500) verdi; üçüncüsü 1,3 sn'de başarılı oldu. Öneri: `getJson` için bir kez yeniden deneme ve bu hatada 502 dön.

**K5 (düşük) — 413 hiç iletilmiyor.**
`lib/api.mjs:8`: sınır aşılınca `req.destroy()` yanıt yazılmadan bağlantıyı kesiyor; istemci `ECONNRESET` görüyor (belge 413 diyor). Öneri: yanıtı yazıp `Connection: close` ile kapat, ya da belgeyi "bağlantı kesilir" diye düzelt.

**K6 (düşük) — `null` gövde 500 ve iç hata metni döndürüyor.**
`lib/api.mjs:4-11`: `JSON.parse('null')` geçerli; `POST /api/items` `null` ile "Cannot read properties of null" (500). Öneri: `readBody` sonunda gövde nesne değilse `UserError('geçersiz gövde')` (400).

**K7 (düşük) — Görseller yarım kaldıysa bir daha denenmiyor.**
`lib/meta.mjs:29` `have` varsa dönüyor, `saveImage` hatayı sessizce yutuyor. Bir denemede meta JSON'u vardı ama `img/` boştu (yerel poster 404, katalog uzak adrese düştü); sonraki denemede görseller indi. Neden kesin değil (geçici ağ hatası olası). Öneri: JSON varken görsel dosyaları eksikse yalnızca onları yeniden indir.

**K8 (bilgi) — `killStale` yalnızca görüntü adına bakıyor.**
`lib/engine.mjs:41`: pid dosyasındaki numara başka bir `rqbit.exe` sürecine (ör. başka bir servis örneği) geçmişse o kapatılır. Öneri: görüntü adına ek olarak süreç yolunu/komut satırını `cfg.rqbitExe` ile karşılaştır. Denenmedi, kod okumasından.

**K9 (bilgi) — Sınamalar sabit kapı kullanıyor.**
`test/harness.mjs:59,94-101`: rqbit 3161/4361/3170+n/4370+n, servis 11590+n. İki kişi aynı anda `npm test` çalıştırırsa çakışır. Öneri: boş kapı bulup kullan.

**Gözlemler (kusur değil):** (a) Çok ilerideki, inmemiş bir bölgeye Range ilk baytı ~17 sn'de verdi (gerçek ağ, az eş); arayüz bekleme göstermeli. (b) Torrentio'dan bazı sürümlerin `quality` alanı boş geliyor (ham veride de boş). (c) Başka sezonun paketi (ör. "5. Temporada") S01 e5 sonuçlarında `episodeCount: 1`, `sizeKind: unknown` bir "paket" olarak çıkıyor; arayüz `episodeCount` ile süzebilir. (d) Seçilmeyen küçük dosyalar (altyazılar) parça sınırında diske düşüyor; rqbit davranışı. (e) Tamamlanmış öğeye halihazırda inmiş parçalara düşen küçük dosya eklemek anında tamamlanıyor.
