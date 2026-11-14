# Offline İndir — HTTP API (Faz 1)

Servis `http://127.0.0.1:11480` adresinde çalışır (yalnızca bu bilgisayardan erişilir). İndirme motoru rqbit, servisin alt sürecidir: bir "kontrol" süreci (API `127.0.0.1:11482`; yalnızca eklemeden dosya listesi için) ve **her etkin indirme için ayrı bir süreç** (API `127.0.0.1:11490+k`, eş kapısı `4241+k`; hepsi dışarıya kapalı). Bu belge Faz 2 arayüzünün (İndirme Merkezi) kullanacağı uçları anlatır.

Genel kurallar:
- Gövdeler JSON'dur (`Content-Type` zorunlu değil). Yanıtlar JSON; hata gövdesi `{ "err": "Türkçe açıklama" }`.
- Tüm uçlar: `Host` başlığı servisin kendi adlarından (`127.0.0.1:port`, `localhost:port`, `[::1]:port`; tek yerde: `cfg.allowedHosts`) biri değilse `403` (DNS yeniden bağlamaya karşı).
- Hata kodları: `400` geçersiz istek, `403` izin verilmeyen köken, `404` öğe yok, `409` duruma uymayan istek (ör. tamamlanmışı iptal), `413` gövde çok büyük, `502/503/504` motor ya da kaynak sorunu.
- Köken (Origin) kuralı: `/api/*` uçları servisin kendi sayfasından (ya da kökensiz: curl, sınama) serbest. `https://web.stremio.com` kökeni yalnızca `GET` uçlarını ve `POST /api/download`, `POST /api/auto`'yu çağırabilir. Diğer kökenler `403`.
- Öğe kimliği (`:id`) torrentin infoHash'idir (40 karakter, küçük harf).
- Boyutlar bayt; hız bayt/sn; kalan süre saniye.

## Öğe (indirme) nesnesi

`GET /api/items/:id` ve listelerde dönen biçim:

```json
{
  "id": "08ada5a7a6183aae1e09d831df6748d566095a10",
  "infoHash": "08ada5a7a6183aae1e09d831df6748d566095a10",
  "name": "Sintel",                       // torrent adı (yoksa başlık)
  "title": "Sintel 2010 720p BluRay",     // Torrentio başlığının ilk satırı
  "displayName": "Sintel",                // Cinemeta adı (varsa)
  "type": "movie",                        // movie | series | null
  "imdbId": "tt1727587",
  "state": "downloading",                 // aşağıya bakın
  "error": null,                          // state=error iken Türkçe açıklama
  "addedAt": 1794589135889, "completedAt": null,
  "sizeBytes": 129241752,                 // seçili dosyaların toplamı
  "doneBytes": 66589336,
  "progress": 0.515, "percent": 51.5,
  "downloadSpeed": 5717329, "uploadSpeed": 0,
  "eta": 11,                              // sn; bilinmiyorsa null
  "peers": 37,                            // bağlı kaynak (eş) sayısı
  "engineState": "live",                  // motor durumu (initializing | live), yalnızca inerken
  "downloadLimit": 2000000,               // bu indirmenin hız sınırı, bayt/sn; 0 = sınırsız (kalıcı)
  "priority": false,                      // öncelikli mi (en çok bir öğe; kalıcı)
  "effectiveLimit": 200000,               // şu an uygulanan sınır (öncelik kısması dahil), bayt/sn
  "throttled": true,                      // başka bir indirmenin önceliği yüzünden kısıldı
  "source": { "title": "...", "quality": "720p", "sizeGB": 0.14, "seeders": 23, "site": "YTS", "languages": ["gb"] },
  "poster": "http://127.0.0.1:11480/img/tt1727587-poster",   // yerelde yoksa ""
  "playUrl": "http://127.0.0.1:11480/play/movie/tt1727587/<infoHash>/5",
  "files": [
    { "idx": 5, "name": "Sintel.mp4", "path": "<indirme klasörü>\\Sintel\\Sintel.mp4", "length": 129241752,
      "selected": true, "doneBytes": 66589336, "progress": 0.515, "complete": false,
      "videoId": "tt1727587", "season": null, "episode": null, "playUrl": "..." }
  ]
}
```

Durumlar (`state`):

| Durum | Anlamı | Geçerli eylemler |
|---|---|---|
| `resolving` | Torrent bilgisi (metadata) bekleniyor. `metadataTimeoutSec` (vars. 90 sn) içinde gelmezse `error` olur. | pause, cancel, delete |
| `downloading` | İniyor. | pause, cancel, delete, files |
| `paused` | Durduruldu; bu indirmenin motor süreci kapatılır, hiçbir şey indirilmez/yüklenmez. Eski (webtorrent dönemi) kayıtlar bu durumla taşınır. | resume, cancel, delete, files |
| `completed` | Seçili dosyaların hepsi indi. Torrent motorda **duraklatılır** (yükleme yok); dosyalar diskten oynatılır. | delete, files (yeni dosya seçmek indirmeyi sürdürür) |
| `error` | Metadata gelmedi ya da motor hata verdi. `error` alanında açıklama. | resume (yeniden dener), cancel, delete |

Notlar:
- `downloadSpeed/peers/eta` yalnızca `downloading` iken dolu; diğer durumlarda 0/null.
- `files[].path` diskteki yerdir. Seçili dosyalar diskte baştan tam boyutta (seyrek) görünür; ilerleme için **`doneBytes`/`progress` kullanılır, dosya boyutu değil**.
- `videoId`: dosyanın Stremio kimliği (film: `tt…`, bölüm: `tt…:sezon:bölüm`). Paketlerde dosya adlarından (S01E02, 1x02, "Season 1/Episode 02" …) çıkarılır.
- Servis yeniden başlatıldığında `downloading` öğeler kaldıkları yerden sürer (baştan inmez); `paused`, `completed`, `error` öğeler için motor süreci açılmaz (süreç yalnızca `resolving`/`downloading` iken vardır; sürdürülünce açılır, veriyi doğrular ve kaldığı yerden sürer). Hiçbir öğe kendiliğinden `paused`dan çıkmaz.

## Uçlar

### Durum
- `GET /api/status` → `{ downloadDir, usedBytes, diskFreeBytes, diskTotalBytes, downloadSpeed, active, engine: { ready, restarts, error, processes }, settings: { defaultDownloadLimit, uploadLimit } }`
  - `engine.ready`: kontrol süreci hazır. `processes`: çalışan indirme süreci sayısı. `restarts`: bütün süreçlerin çökme sonrası yeniden başlama toplamı.
  - `usedBytes`: kütüphanedeki inmiş verinin toplamı. `diskFreeBytes`: indirme klasörünün bulunduğu diskte boş alan.
- `GET /api/items` → `{ summary: <status ile aynı>, items: [öğe, …] }` (en yeni önce). Arayüz bunu ~1 sn'de bir sorgulayabilir.
- `GET /api/items/:id` → öğe.

### Ekle
`POST /api/items`
```json
{ "infoHash": "…" | "magnet": "magnet:?xt=…",
  "files": [0, 2] | null,          // torrent içindeki dosya numaraları; null = otomatik seçim
  "trackers": ["udp://…"],         // isteğe bağlı (Torrentio'dan bilinenler kendiliğinden eklenir)
  "type": "movie" | "series", "id": "tt…" | "tt…:1:2",
  "title": "…", "source": { … } }
```
- Hemen döner: yeni öğe `201 { existed: false, item }` (durum `resolving`); aynı torrent zaten varsa `200 { existed: true, item }` ve istenen dosyalar seçime eklenir.
- `files: null` iken: `id` bir bölümse o bölümün dosyası, değilse en büyük video dosyası seçilir.
- Dosya numaraları `GET /api/torrents/:id/files` ya da Torrentio sürümlerindeki `fileIdx` ile bilinir.

### Duraklat / sürdür / iptal / sil / dosya seçimi
- `POST /api/items/:id/pause` → öğe. Tekrar çağrılabilir. `completed` için `409`.
- `POST /api/items/:id/resume` → öğe. `paused`/`error` öğeyi yeniden başlatır (metadata gerekirse yeniden çözer).
- `POST /api/items/:id/cancel` → `{ ok: true }`. İndirmeyi durdurur, **inmiş kısmı siler**, öğeyi kaldırır. `completed` için `409` (onun yerine silin).
- `DELETE /api/items/:id` (ya da `POST /api/items/:id/delete`) → `{ ok: true }`. Öğeyi ve dosyalarını siler. `?keepFiles=1` ile dosyalar diskte kalır, yalnızca kayıt kalkar. Yalnızca indirme klasörü (ya da öğenin kendi klasörü) içindeki dosyalar silinir.
- `POST /api/items/:id/files` gövde `{ "files": [0, 2, 3] }` → öğe. Seçimi değiştirir (paketten bölüm ekle/çıkar). Tamamlanmış öğeye yeni dosya eklemek indirmeyi sürdürür.

### Hız sınırı
Birim **bayt/sn**, `0` = sınırsız, en çok 4294967295. Geçersiz değer `400`.
- `POST /api/items/:id/limit` gövde `{ "downloadLimit": 2000000 }` → öğe. Bu indirmenin indirme sınırı. Çalışan sürece **hemen** uygulanır (süreç yeniden başlamaz); öğede saklanır, yeniden başlatmada korunur. Duraklatılmış/hatalı öğede kaydedilir, sürdürülünce geçerli olur.
- `GET /api/settings` → `{ defaultDownloadLimit, uploadLimit, priorityThrottle }`.
- `POST /api/settings` gövde (alanların hepsi isteğe bağlı) `{ "defaultDownloadLimit": 0, "uploadLimit": 100000, "applyToAll": true }` → ayarlar.
  - `defaultDownloadLimit`: yeni eklenen indirmelerin aldığı sınır. Var olanlar değişmez.
  - `applyToAll: true`: varsayılanı **bütün** öğelere yazar (çalışanlara hemen uygulanır).
  - `uploadLimit`: yükleme sınırı; her süreç için ayrı uygulanır (N etkin indirme ≈ N × sınır). Bitmiş indirme zaten yükleme yapmaz (süreci kapatılır).
  - Kalıcı: `data/ayarlar.json`. İlk değerler `config.json` (`downloadLimit`, `uploadLimit`) ya da `OFFLINE_RATELIMIT_DOWN`/`OFFLINE_RATELIMIT_UP`'tan gelir; arayüzden değiştirilen değer sonra geçerlidir.
- `POST /api/items/:id/priority` gövde `{ "priority": true | false }` → öğe. **Öncelik**: aynı anda en çok bir öğe öncelikli olur (yenisi verilince önceki kalkar). Öncelikli öğe etkinken (`resolving`/`downloading`) diğer etkin indirmelerin etkin sınırı `min(kayıtlı sınır, priorityThrottle)` olur; durmazlar, kayıtlı `downloadLimit` değişmez (`throttled`, `effectiveLimit` alanları gösterir). Öncelikli öğe duraklatılınca, bitince, silinince ya da öncelik kaldırılınca diğerleri kendi sınırlarına döner (duraklatmada işaret kalır, sürdürülünce kısma yeniden başlar; bitince/silinince işaret kalkar). Tamamlanmış öğeye `409`. Kalıcıdır.
- `POST /api/settings` `{ "priorityThrottle": 200000 }`: kısma hızı (vars. 200 KB/sn; `0` = öncelik kimseyi kısmaz), kalıcı, çalışan süreçlere hemen uygulanır.
- `GET /api/engines` (tanı) → `{ control: { apiPort, pid, ready }, engines: [{ infoHash, slot, apiPort, peerPort, pid, ready, restarts, limits }] }`.

### Torrentio katmanı
- `GET /api/versions?type=movie&id=tt1727587` ya da `?type=series&id=tt0903747:1:2` → `{ type, id, versions: [sürüm, …] }` (seeder'a göre azalan). Sürüm:
  ```json
  { "infoHash": "…", "fileIdx": 13, "name": "Torrent adı", "fileName": "Dosya.mkv",
    "quality": "1080p", "tags": ["HEVC","HDR"], "sizeBytes": 1513975971, "sizeGB": 1.51,
    "seeders": 29, "source": "1337x", "languages": ["gb","tr"], "languageTags": ["Multi Audio"],
    "languageText": "Multi Audio / 🇬🇧 / 🇹🇷", "trackers": ["udp://…"],
    "kind": "single" | "collection" | "episode" | "pack",
    "type": "series", "id": "tt…:1:2", "title": "Torrentio'nun ham metni",
    "library": null | { "state": "downloading", "fileSelected": true, "fileComplete": false } }
  ```
  - `languages`: Torrentio bayraklarından ülke kodları (`gb`, `tr`, `ru` …). Bayrak yoksa boş dizi (çoğunlukla yalnız İngilizce demektir, ama kesin değil).
  - `kind` (dizi): `episode` tek bölüm torrenti, `pack` sezon/dizi paketi (bu bölüm `fileIdx` dosyasında). Film: `single`, çok dosyalıysa `collection`.
  - `sizeGB` ondalık GB (1e9). Torrentio'nun değeri bazen bölüm dosyasının, bazen tüm torrentin boyutudur; kesin boyut için `GET /api/torrents/:id/files`.
- `GET /api/season?id=tt0903747&season=1` → sezonun tüm bölümleri için Torrentio'yu sorar (Cinemeta bölüm listesi; en çok 4 eşzamanlı istek, sonuçlar 10 dk önbellekte):
  ```json
  { "imdbId": "tt0903747", "season": 1, "name": "Breaking Bad", "episodeCount": 7,
    "packs": [ { "infoHash": "…", "name": "…", "quality": "1080p", "seeders": 358, "source": "Rutracker",
                 "languages": [], "trackers": [], "multiSeason": false,
                 "episodeCount": 7,                              // bu sezondan kapsadığı bölüm
                 "episodes": [ { "season": 1, "episode": 1, "fileIdx": 0, "fileName": "…", "reportedBytes": … } ],
                 "sizeBytes": …, "sizeGB": 8.68,                  // Torrentio'nun bildirdiği
                 "sizeKind": "episode" | "torrent" | "unknown",   // yukarıdaki değer neyin boyutu
                 "seasonBytes": …, "seasonGB": 55.3,              // sizeKind=episode ise bölümlerin toplamı, değilse null
                 "library": null } ],
    "episodes": [ { "season": 1, "episode": 1, "id": "tt0903747:1:1", "title": "Pilot", "released": "…",
                    "error": null, "options": [sürüm, …] } ] }
  ```
  Paketler kapsadıkları bölüm sayısı, sonra seeder'a göre sıralıdır. `multiSeason: true` adından birden çok sezon içerdiği anlaşılan paketlerdir.
- `GET /api/torrents/:infoHash/files?season=1` → torrenti **eklemeden** dosya listesi (metadata motorla çözülür; ilk çağrı birkaç saniye sürebilir, en çok `metadataTimeoutSec`, aşılırsa `504`):
  ```json
  { "infoHash": "…", "name": "…", "totalBytes": …,
    "files": [ { "idx": 0, "name": "…", "path": "Klasör/Dosya.mkv", "length": …, "video": true, "season": 1, "episode": 1 } ],
    "episodes": [ { "season": 1, "episode": 1, "fileIdx": 0, "name": "…", "length": … } ],
    "episodeCount": 7, "episodesBytes": 55290000000 }
  ```
  `season` verilirse `episodes` yalnızca o sezonu içerir. Sezon seçici "bölüm sayısı ve toplam GB"yi buradan gösterir; seçilen bölümlerin `fileIdx` listesi `POST /api/items` `files` alanına gider.

### Başlık arama (Faz 2)
- `GET /api/search?q=breaking%20bad` → `{ q, results: [{ type: "movie"|"series", id: "tt…", name, year, poster }] }`. Cinemeta'nın herkese açık arama kataloğunu (`v3-cinemeta.strem.io/catalog/<tür>/top/search=…`) film ve dizi için sorar; adında arama sözcüğü geçenler öne alınır, türü başına en çok 15 sonuç, 5 dk önbellek. `q` en az 2 karakter (`400`). İnternet yoksa `502`. `poster` uzak adrestir (çevrimdışıyken görünmez).
- `GET /api/title?type=series&id=tt0903747` → `{ type, id, name, year, poster, description, seasons: [{ season, episodes }] }`. Sezon seçiciye giden sezon listesi (0 = özel bölümler). Cinemeta'ya gider (`502` alınamazsa).

### Oynatma
- `GET /play/:type/:id/:infoHash/:fileIdx` (`fileIdx` bilinmiyorsa `x`). Stremio'nun kayıtlı adresleriyle aynı biçim.
  - Dosya tamamsa **diskten** sunulur (motor gerekmez, internetsiz çalışır).
  - Değilse motorun akışından sunulur: `Range` desteklenir, inmemiş bir yere atlamak o bölgeyi öne alır. Öğe kütüphanede yoksa yalnızca son 6 saatte bir Torrentio listesinde görülmüş hash için oluşturulur (başka hash için `404`, indirme başlamaz); duraklatılmışsa sürdürülür, dosya seçili değilse seçime eklenir (Stremio'daki "İndir+Oynat" davranışı).
  - `HEAD` desteklenir; aralık dışı `416`. Yanıtta `Accept-Ranges: bytes`, `Content-Type` uzantıya göre.

### Eski uçlar (inject.js ve eski panel için korunur)
- `POST /api/download` gövde `{ type, id, infoHash, fileIdx, trackers, title, fileName }` → `{ ok, state, message, item }`. Zaten varsa: tamamlandıysa "Zaten indirilmiş", duraklatılmış/hatalıysa sürdürür, iniyorsa "Zaten iniyor (%x)".
- `POST /api/auto` gövde `{ type, id }` → ayarlardaki kalite/boyut sınırına uyan en çok kaynaklı sürümü ekler. Aynı içerik varsa yukarıdaki gibi davranır.
- `GET /api/library` → `{ downloadDir, items: [öğe, …] }`.
- `POST /api/delete?key=<infoHash>[:<fileIdx>]` → öğeyi siler.

### Stremio eklenti uçları
`/manifest.json`, `/stream/:type/:id.json` (kütüphanedeki dosyalar + Torrentio'dan "⬇ İndir+Oynat" satırları), `/catalog/:type/offline-movies|offline-series.json`, `/meta/:type/:id.json` (yalnızca kütüphanedekiler), `/img/:imdbId-poster|background|logo`, `/logo.svg`.

## İndirme Merkezi arayüzü (Faz 2)

Servis kökü (`/`) tek sayfalık arayüzü sunar; dosyalar `web/` altında (`index.html`, `stil.css`, `yardimci.js`, `app.js`; `yardimci.js` saf yardımcılardır: kalite grupları, hata/silme metni), `/ui/<dosya>` adresinden okunur. Çatı kütüphane ve derleme adımı yok. Ekranlar adres parçasıyla (`#`) açılır:

| Adres | Ekran |
|---|---|
| `/#/` | İndirmeler / İndirilenler (özet şeridi, hız sınırı ve öncelik kısma ayarları, kartlar, duraklat/sürdür/iptal/sil/oynat, kart başına hız sınırı ve ★ öncelik) |
| `/#/indirilenler` | Aynı liste, başlığı "İndirilenler"; Stremio'nun gezinme çubuğundaki giriş ve film sayfasındaki "İndirildi/İniyor" düğmesi bunu açar |
| `/#/ara`, `/#/ara/<söz>` | Başlık arama |
| `/#/dizi/<tt…>` | Dizinin sezon listesi |
| `/#/surum/movie/<tt…>`, `/#/surum/series/<tt…:sezon:bölüm>` | Sürüm seçici (film ya da tek bölüm) |
| `/#/sezon/<tt…>/<sezon>` | Sezon seçici (paket ya da bölüm bölüm) |

### Gömülü kip ve ana pencere ile haberleşme
Sayfa `?embed=1` ile açılırsa (ör. `http://127.0.0.1:11480/?embed=1#/surum/movie/tt1727587`) iframe içinde kullanılmak üzere sıkı üst çubuk gösterir, görünür bir "Kapat" düğmesi ve Esc ile kapatma sunar; "oynat" bir adrese gitmek yerine ana pencereye ileti yollar. Gönderim `window.parent.postMessage(ileti, hedefKöken)` iledir; hedef köken, tarayıcı bildirirse doğrudan üst pencerenin kökenidir (`location.ancestorOrigins[0]`), yoksa `*`. Tüm iletilerde `source: 'offline-indir'` vardır; ana pencere bunu ve `event.origin`'i (servis kökeni) denetlemelidir.

```js
// Kapat düğmesi ya da Esc
{ source: 'offline-indir', type: 'kapat' }

// Bir öğe için "Oynat" (İndirilenler kartı, bölüm satırı ya da sürüm seçicide "İndir + oynat"/"Oynat")
{ source: 'offline-indir', type: 'oynat', item: {
    id, infoHash,            // kütüphane öğesi (torrent infoHash'i)
    type,                    // 'movie' | 'series' | null
    imdbId,                  // 'tt…' | null
    videoId,                 // Stremio kimliği: film 'tt…', bölüm 'tt…:sezon:bölüm'
    season, episode,         // bölüm değilse null
    fileIdx, fileName,       // oynatılacak dosya (torrent içindeki numara, ad)
    title, name,             // görünen ad (Cinemeta), torrent adı
    state, poster,           // öğe durumu; yerel afiş adresi ('' olabilir)
    playUrl                  // mutlak oynatma adresi: http://127.0.0.1:11480/play/<tür>/<kimlik>/<infoHash>/<dosya>
} }
```

Gömülü olmayan kipte "oynat" aynı `playUrl`'i yeni sekmede açar. Ana pencereden sayfaya iletiyle komut gönderilmez; sayfa adresi (`#/…`) değiştirilerek istenen ekran açılır.

## Ayarlar (`config.json`)

| Anahtar | Varsayılan | Not |
|---|---|---|
| `port` | 11480 | servis kapısı |
| `downloadDir` | kullanıcının Videos\Stremio-Offline klasörü | |
| `torrentioUrl` | `https://torrentio.strem.fun` | ayarlı Torrentio adresi verilebilir |
| `showDownloadRows`, `autoQuality`, `autoMaxSizeGB`, `debugPort` | | önceki sürümle aynı |
| `rqbitApiPort` | 11482 | kontrol motorunun API'si, yalnızca 127.0.0.1 |
| `rqbitPeerPort` | 4240 | kontrol motorunun eş kapısı |
| `engineApiPortBase`, `enginePeerPortBase`, `engineSlots` | 11490, 4241, 100 | indirme süreçlerinin kapıları: yuva k için API `11490+k`, eş `4241+k` |
| `peerListenIp` | `127.0.0.1` | eşleri dinleme adresi. 127.0.0.1: yalnızca giden bağlantı (gerçek ağda denendi, Sintel ~5 MiB/s); güvenlik duvarı sorusu çıkmaz. `null`: rqbit varsayılanı (tüm arayüzler) |
| `metadataTimeoutSec` | 90 | |
| `downloadLimit` | 0 | yeni indirmeler için varsayılan sınırın **ilk değeri**, bayt/sn, 0 sınırsız (sonrası `data/ayarlar.json`) |
| `uploadLimit` | 100000 | yükleme sınırının ilk değeri, bayt/sn, süreç başına |
| `priorityThrottle` | 200000 | öncelik varken diğer etkin indirmelerin kısıldığı hız, ilk değer (sonrası `data/ayarlar.json`) |

UPnP kapalıdır (`--disable-upnp-port-forward`), DHT durumu diske yazılmaz (`--disable-dht-persistence`; aynı anda birden çok süreç böylece çakışmaz). Motor oturum kalıcılığı kapalıdır (`--disable-persistence`): doğruluk kaynağı `library.json` + `.torrent` önbelleği (`data/torrents/`); süreç her başladığında torrent aynı klasöre yeniden eklenip doğrulanır. Günlükler: kontrol `data/rqbit/rqbit.log`, indirme süreçleri `data/rqbit/motorlar/<yuva>/rqbit.log` (pid dosyası da orada); servis günlüğü `data/servis.log`. Eski tek oturum (`data/rqbit/oturum`) ilk açılışta `data/rqbit/oturum.v1-yedek` olarak kenara alınır.

## Ortam değişkenleri (sınama)

| Değişken | Etki |
|---|---|
| `OFFLINE_DATA_DIR` | Veri klasörü. Verilirse kökteki `config.json` **okunmaz/yazılmaz**, indirme klasörü varsayılanı `<veri>/indirilenler` olur. |
| `OFFLINE_DOWNLOAD_DIR` | İndirme klasörü |
| `OFFLINE_PORT`, `OFFLINE_RQBIT_PORT`, `OFFLINE_PEER_PORT` | Kapılar |
| `OFFLINE_PEER_LISTEN_IP` | `peerListenIp` (boş = rqbit varsayılanı) |
| `OFFLINE_TORRENTIO_URL`, `OFFLINE_METADATA_TIMEOUT`, `OFFLINE_RATELIMIT_DOWN`, `OFFLINE_RATELIMIT_UP` | Ayar karşılıkları (`downloadLimit`, `uploadLimit`: ilk değer) |
| `OFFLINE_ENGINE_API_BASE`, `OFFLINE_ENGINE_PEER_BASE`, `OFFLINE_ENGINE_SLOTS` | İndirme süreçlerinin kapı aralığı |
| `OFFLINE_RQBIT_EXE` | rqbit yolu (sınama) |
| `OFFLINE_LOOPBACK=1` | DHT/tracker/LSD kapalı (internetsiz sınama) |
| `OFFLINE_EXTRA_PEERS=ip:port,…` | Her eklemede/sürdürmede motora verilen eşler (sınama tohumlayıcısı) |
| `OFFLINE_NO_INJECT=1` | Stremio arayüzüne düğme ekleme kapalı |
| `OFFLINE_STDIN_CONTROL=1` | stdin'den `kapat` satırı gelince temiz kapanır |
| `OFFLINE_POLL_MS` | Motor durum sorgu aralığı (vars. 1000) |

Sınamalar: `npm test` (yerel döngü, internetsiz; geçici klasörde çalışır, kullanıcı verisine dokunmaz).
