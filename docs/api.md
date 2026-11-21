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
  "priorityIdle": false,                  // ★ ama etkin ve veri almıyor (metadata bekliyor/takılı): kimseyi kısmaz
  "playing": false,                       // bu indirmeden akış (oynatma) sunuluyor: kısma ve kayıtlı sınır askıda (effectiveLimit 0)
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
- `GET /api/status` → `{ downloadDir, usedBytes, diskFreeBytes, diskTotalBytes, downloadSpeed, active, engine: { ready, restarts, error, processes }, settings: { defaultDownloadLimit, uploadLimit, priorityThrottle } }`
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
Birim **bayt/sn**, `0` = sınırsız. Doğrulama katıdır: değer JSON **sayı** (`typeof number`), tam sayı ve `0` ya da `1000`–`4294967295` olmalı; dize, bool, dizi, kesirli, 1000'den küçük pozitif ya da negatif değer `400`. `POST /api/settings` önce bütün alanları doğrular, sonra uygular (geçersiz alan varsa hiçbiri uygulanmaz, `400`). `applyToAll` yalnız `true` (boolean) iken etkilidir.
- `POST /api/items/:id/limit` gövde `{ "downloadLimit": 2000000 }` → öğe. Bu indirmenin indirme sınırı. Çalışan sürece **hemen** uygulanır (süreç yeniden başlamaz); öğede saklanır, yeniden başlatmada korunur. Duraklatılmış/hatalı öğede kaydedilir, sürdürülünce geçerli olur.
- `GET /api/settings` → `{ defaultDownloadLimit, uploadLimit, priorityThrottle }`.
- `POST /api/settings` gövde (alanların hepsi isteğe bağlı) `{ "defaultDownloadLimit": 0, "uploadLimit": 100000, "applyToAll": true }` → ayarlar.
  - `defaultDownloadLimit`: yeni eklenen indirmelerin aldığı sınır. Var olanlar değişmez.
  - `applyToAll: true`: varsayılanı **bütün** öğelere yazar (çalışanlara hemen uygulanır).
  - `uploadLimit`: yükleme sınırı; her süreç için ayrı uygulanır (N etkin indirme ≈ N × sınır). Bitmiş indirme zaten yükleme yapmaz (süreci kapatılır).
  - Kalıcı: `data/ayarlar.json`. İlk değerler `config.json` (`downloadLimit`, `uploadLimit`) ya da `OFFLINE_RATELIMIT_DOWN`/`OFFLINE_RATELIMIT_UP`'tan gelir; arayüzden değiştirilen değer sonra geçerlidir.
### İndirme klasörü (sonradan değiştirilebilir)
- `GET /api/settings` artık ayrıca `downloadDir` (geçerli klasör) ve `autoUpdateCheck` döndürür. `POST /api/settings` gövdesinde `"downloadDir": "D:\\Filmler"` verilirse: yol **mutlak** olmalı (`C:\Filmler` ya da `\\sunucu\paylaşım`), yoksa oluşturulur, yazılabilir olmalı (deneme dosyası yazılıp silinir); hatalıysa `400 { err }` (Türkçe, ör. "Bu klasöre yazılamıyor…") ve hiçbir alan uygulanmaz. Kalıcıdır (`data/ayarlar.json` `downloadDir`); kayıtlı değer `config.json`/`OFFLINE_DOWNLOAD_DIR`'dan önceliklidir. Kayıtlı klasör sonradan kullanılamaz olursa servis varsayılanla açılır, dosyadaki değer ezilmez.
- **Yalnız yeni indirmelere uygulanır.** Her öğe eklendiği anki klasörü kaydında saklar (`downloadDir`; önceki sürümden kalan öğeler ilk açılışta o günkü klasörle işaretlenir). Süren, duraklatılmış ve biten indirmeler eski yerinde kalır: sürdürme (motor aynı `output_folder` ile yeniden eklenir), oynatma (`files[].path`), İndirilenler, "Offline oynat", silme hep öğenin kendi yolunu kullanır. `GET /api/status` ve `/api/library` `downloadDir`'i yeni indirmelerin gideceği klasördür; boş disk bu klasörün diskidir.
- `POST /api/klasor-sec` (gövdesiz) → sunucu **kullanıcının masaüstünde** gizli bir PowerShell (`-STA`) ile Windows klasör seçme penceresini açar (en önde, mevcut klasörde başlar). Yanıt `{ "path": "D:\\Filmler" }` ya da iptalde `{ "cancelled": true }`; seçmek ayarı değiştirmez, ardından `POST /api/settings` çağrılır. Pencere açıkken ikinci çağrı `409`, pencere açılamazsa `502` (arayüz elle yol girişine düşer; 5 dk cevapsız kalırsa iptal sayılır). `OFFLINE_KLASOR_SECICI`: pencere yerine çalıştırılacak program (`.mjs/.js` node ile; stdout'a seçilen yolu yazar, boş çıktı = iptal). **Sınama kipinde bu değişken yoksa gerçek pencere açılmaz** (`503`).
- `POST /api/items/:id/priority` gövde `{ "priority": true | false }` → öğe. **Öncelik**: aynı anda en çok bir öğe öncelikli olur (yenisi verilince önceki kalkar). Öncelikli öğe **gerçekten veri alırken** (motor canlı ve indirilen bayt son 10 sn içinde artmış; metadata beklerken ya da takılıyken kısma yok, kısma başladıktan sonra 20 sn hiç ilerleme olmayınca kalkar: salınım yok; ★ işareti kalır, `priorityIdle` gösterir) diğer etkin (`resolving`/`downloading`) indirmelerin etkin sınırı `min(kayıtlı sınır, priorityThrottle)` olur; durmazlar, kayıtlı `downloadLimit` değişmez (`throttled`, `effectiveLimit` alanları gösterir). Öncelikli öğe duraklatılınca, bitince, silinince ya da öncelik kaldırılınca diğerleri kendi sınırlarına döner (duraklatmada işaret kalır, sürdürülünce kısma yeniden başlar; bitince/silinince işaret kalkar). Tamamlanmış öğeye `409`. Kalıcıdır.
- **Oynatma muafiyeti:** `/play/...` ile bir indirmeden **akış** (stream/Range) sunulurken o indirme hem öncelik kısmasından hem kendi kayıtlı sınırından muaftır: etkin sınır sınırsızdır (`playing: true`, `effectiveLimit: 0`, `throttled: false`). Muafiyet açık akış bağlantısı sayısına bağlıdır (uzun Range isteği sürerken sürer) ve son bağlantı kapandıktan 30 sn sonra kalkar (`playGraceMs` / `OFFLINE_PLAY_GRACE_MS`); sınırlar eski hesabına döner, kayıtlı `downloadLimit` hiç değişmez. Oynatılan öğe başkasını kısmaz (öncelik işareti değişmez). Yükleme sınırına dokunulmaz. Diskten sunulan (tamamlanmış) dosyada motor olmadığı için etkisi yoktur.
- `POST /api/settings` `{ "priorityThrottle": 200000 }`: kısma hızı (vars. 200 KB/sn; `0` = öncelik kimseyi kısmaz), kalıcı, çalışan süreçlere hemen uygulanır.
- `GET /api/engines` (tanı) → `{ control: { apiPort, pid, ready }, engines: [{ infoHash, slot, apiPort, peerPort, pid, ready, restarts, limits }] }`.

### Genel ayarlar ve kurallar (Ayarlar sayfası, 1.2.0)
`GET /api/settings` hız sınırları, `downloadDir`, `autoUpdateCheck` ile birlikte şu alanları da döndürür; `POST /api/settings` ile değişir (önce hepsi doğrulanır, geçersiz alan varsa hiçbiri uygulanmaz, `400`). Kalıcıdır (`data/ayarlar.json`). Doğrulama `lib/settings.mjs` `GENEL`.

| Alan | Tür | Varsayılan | Anlamı |
|---|---|---|---|
| `maxConcurrent` | tam sayı 0–20 | 0 | Aynı anda en çok kaç indirme (0 = sınırsız); fazlası `autoPaused: "kuyruk"` ile bekler |
| `scheduleOn`, `scheduleStart`, `scheduleEnd` | bool, `"SS:DD"` | false, 01:00, 08:00 | Yalnız bu saatlerde indir (gece yarısını aşabilir; başlangıç = bitiş bütün gün); dışında `autoPaused: "saat"` |
| `minFreeGB` | tam sayı | 0 | Diskte bundan az yer kalınca oynatılmayan indirmeler durur (`"disk"`), +1 GiB açılınca sürer |
| `notifyOnComplete` | bool | true | İndirme bitince Windows bildirimi (gizli PowerShell, NotifyIcon) |
| `autoQuality`, `autoMaxSizeGB` | `2160p/1080p/720p/480p`, 1–1000 | config.json | Kart menüsündeki "Cihaza indir" otomatik seçimi |
| `preferTurkish` | bool | false | Sürüm listesinde ve otomatik seçimde Türkçe (🇹🇷, TR, Dublaj…) önce (`torrentio.mjs` `isTurkish`) |
| `clipSeconds`, `clipStartPct` | 30/60/90, 0–90 | 60, 30 | Klip uzunluğu ve başlangıç noktası (sürenin yüzdesi) |
| `showBadges` | bool | true | Stremio posterlerinde rozet (`/api/items` `summary.settings.showBadges`) |
| `deleteWatchedDays` | tam sayı 0–3650 | 0 | Bitmiş indirme son oynatmasından bu kadar gün sonra dosyasıyla silinir (0 = kapalı); hiç oynatılmamışa dokunulmaz |
| `seedMode` | `kapali` / `acik` / `sinirli` | `kapali` (config `seedAfterDownload: true` ise `acik`) | Bitince paylaşım (seed). `kapali`: süreç kapanır, yükleme yok. `acik`: süreç açık kalır, yükleme `uploadLimit` ile. `sinirli`: yükleme `seedLimit` ile. `kapali`ya alınınca paylaşılanlar hemen durur. Servis yeniden açılınca paylaşım sürmez (yeniden doğrulama yükü olmasın). Öğe görünümünde `seeding`, `uploadSpeed`, `peers`, `seedUploadedBytes` |
| `seedLimit` | bayt/sn (hız sınırı kuralı) | 100000 | `sinirli` kipte paylaşım hızı |

Kurallar (`lib/kurallar.mjs`, `OFFLINE_KURAL_MS` aralıkla, vars. 15 sn; ayar değişince ve indirme bitince hemen): öğe görünümünde `autoPaused` (`kuyruk` | `saat` | `disk` | `null`) ve `lastPlayedAt`. Kullanıcı duraklatırsa `autoPaused` silinir, kural o öğeyi sürdürmez. Oynatılan indirme ve kural engellerken elle sürdürülen (ya da İndir+oynat ile başlatılan) indirme saat/kuyruk kuralından muaftır (bitene ya da elle duraklatılana dek); disk kuralı oynatılmayan her indirmeye uygulanır. Kuyrukta önce öncelikli, sonra en eski eklenen başlar; sınır aşılırsa en yeni eklenen sıraya döner.

- `GET /api/kurallar` → `{ diskLow, diskFreeBytes, offHours, autostart }`.
- `POST /api/bakim/klip-temizle` → `{ freedBytes, count }` (çalışan klip işi hariç).
- `POST /api/bakim/gunluk-ac` → veri klasörünü Gezgin'de açar, `{ path }`. Sınama kipinde `OFFLINE_KLASOR_ACICI` yoksa `503`.
- `POST /api/bakim/izlenenleri-sil` → `deleteWatchedDays` kuralını hemen uygular (kapalıysa `400`).
- `GET|POST /api/bakim/otobaslat` `{ enabled }` → Başlangıç klasöründeki "Stremio Offline Servis" kısayolu (`data/kurulum.json` `klasorler.baslangic`, yoksa Windows'un Startup klasörü; `kur.ps1` ile aynı hedef/argüman). Sınama kipinde `OFFLINE_BASLANGIC_KLASORU` yoksa değiştirilemez (`503`); `OFFLINE_KISAYOL_YAZICI` kısayolu yazan program (sınama).
- Sınama: `OFFLINE_BILDIRIM_KOMUTU` bildirim programı (`SO_BASLIK`, `SO_METIN` ortam değişkenleriyle); sınama kipinde yoksa bildirim gösterilmez.

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
- `GET /api/title?type=series&id=tt0903747` → `{ type, id, name, year, poster, description, runtime, seasons: [{ season, episodes }] }`. Sezon seçiciye giden sezon listesi (0 = özel bölümler). `runtime`: Cinemeta'nın süre metni ("2h 10min", "130 min"; dizide bölüm süresi; yoksa `""`), sürüm seçicinin kalite rozeti için. Cinemeta'ya gider (`502` alınamazsa).

### Oynatma
- `GET /play/:type/:id/:infoHash/:fileIdx` (`fileIdx` bilinmiyorsa `x`). Stremio'nun kayıtlı adresleriyle aynı biçim.
  - Dosya tamamsa **diskten** sunulur (motor gerekmez, internetsiz çalışır).
  - Değilse motorun akışından sunulur: `Range` desteklenir, inmemiş bir yere atlamak o bölgeyi öne alır. Öğe kütüphanede yoksa yalnızca son 6 saatte bir Torrentio listesinde görülmüş hash için oluşturulur (başka hash için `404`, indirme başlamaz); duraklatılmışsa sürdürülür, dosya seçili değilse seçime eklenir (Stremio'daki "İndir+Oynat" davranışı).
  - `HEAD` desteklenir; aralık dışı `416`. Yanıtta `Accept-Ranges: bytes`, `Content-Type` uzantıya göre.

### Bilgisayarı kapatma zamanlayıcısı
(`POST /api/kapat` **servisi** kapatır; bu uç **bilgisayarı**. Yalnızca servisin kendi sayfasından / kaynaksız yerel istek; Stremio kökeni `POST` yapamaz.)
- `GET /api/kapat-zamanla` → `{ armed, countdown, phase: "kapali" | "bekliyor" | "geri-sayim", secondsLeft, endsAt, active, simulated, message }`.
- `POST /api/kapat-zamanla` gövde `{ "enabled": true | false }` (boolean zorunlu, aksi `400`) → aynı durum. **Bellekte tutulur, kalıcı değildir** (servis yeniden başlayınca kapalı); tetiklenince kendini kapatır.
  - `true`: **etkin (`resolving`/`downloading`) indirme yoksa `409`** (karar: böyle bir anahtar ya hemen kapatır ya da haftalarca gizlice bekler; ikisi de sürpriz). Etkin indirme varken açılır.
  - Tetikleme: açıldıktan sonra etkin indirme kalmayınca (2 ardışık denetim, `OFFLINE_KAPAT_KONTROL_MS`, vars. 2 sn) **ve açıldıktan sonra en az bir indirme tamamlanmışsa**. Duraklatılmış/hatalı öğeler beklenmez. Hiçbiri tamamlanmadan etkin indirme kalmazsa (hepsi duraklatıldı/iptal/hata) bilgisayar kapatılmaz, anahtar kendiliğinden kapanır (`message` açıklar).
  - Tetiklenince `shutdown.exe /s /t 60 /c "Stremio Offline: indirmeler bitti…"` çalışır (Windows'un kendi geri sayımı); `phase: "geri-sayim"`, `secondsLeft`. Komut başarısızsa bilgisayar kapanmaz, `message` söyler.
  - `false`: zamanlamayı kapatır; geri sayım sürüyorsa `shutdown.exe /a` ile iptal eder (iptal edilemezse `502`; elle `shutdown /a`).
  - **Güvenlik:** gerçek `shutdown.exe`'ye yalnız sınama kipi DEĞİLken ve `OFFLINE_KAPATMA_KOMUTU` verilmemişken gidilir. `OFFLINE_KAPATMA_KOMUTU` bir program/betik yoludur (`.mjs/.js` node ile), aynı bağımsız değişkenlerle (`/s /t 60 /c …`, `/a`) çalışır. Sınama kipinde (`OFFLINE_DATA_DIR`) değişken yoksa **hiçbir program çalışmaz**: yalnız günlüğe yazılır, `simulated: true` sahte geri sayım görünür.

### Güncelleme denetimi
`package.json` sürümü ile GitHub'ın son sürümü (`https://api.github.com/repos/<updateRepo>/releases/latest`, `config.json` `updateRepo`, vars. `AcarPlus/stremio-offline`) karşılaştırılır; `tag_name` "v1.2.0" biçimi, basit sayısal semver (ön ek/son ek yok sayılır). **Otomatik indirme/kurma yok**, yalnız bilgi.
- `GET /api/guncelleme` → son durum: `{ current, status, available, latest, tag, url, checkedAt, error, autoUpdateCheck, repo }`. `status`: `hic` (henüz denetlenmedi) | `guncel` | `yeni` (`available: true`; `url` sürüm sayfası, yalnız `https://`) | `surum-yok` (depo yayında değil / 404: normal) | `denetlenemedi` (ağ yok, zaman aşımı, 5xx, bozuk yanıt: sessiz, `error` kısa neden).
- `POST /api/guncelleme/denetle` (gövdesiz) → denetler (en çok 10 sn) ve aynı durumu döndürür.
- Ek alanlar (1.3.0): `exeKurulumu` (kökte Inno kaldırıcısı `unins000.exe` var), `kurulabilir` (yeni sürüm + sürümde `StremioOffline-Kurulum*.exe` + GitHub `digest` SHA-256 + exe kurulumu), `setupSize`, `kurulum: { asama: yok|indiriliyor|baslatildi|hata, yuzde, hata }`.
- `POST /api/guncelleme/kur` (yalnız servisin kendi sayfasından; Stremio kökeni `403`) → indirmeyi arka planda başlatır, durumu döndürür. Adres yalnız https + github.com / objects|release-assets.githubusercontent.com (her yönlendirme denetlenir); boyut ve SHA-256 tutmazsa kurulmaz. Sonra kurulum programı `/SILENT /SUPPRESSMSGBOXES /NORESTART /UPDATE` ile ayrık başlatılır ve servis ~1,5 sn sonra kapanır; kurulum bitince servisi yeniden başlatır. Elle kurulum (geliştirme klasörü, eski zip), özetsiz sürüm, süren güncelleme: `409`. Sınama: `OFFLINE_GUNCELLEME_KURUCU` (kurulum yerine çalışan program, ilk argümanı indirilen dosya), `OFFLINE_GUNCELLEME_EXE_KURULUMU=1|0`; sınama kipinde bunlar yoksa hiçbir program çalışmaz.
- Otomatik: servis açılışından ~1 dk sonra ve 24 saatte bir, `autoUpdateCheck` açıksa (vars. açık, kalıcı; `POST /api/settings { "autoUpdateCheck": false }`). İstekte `User-Agent: stremio-offline`, başka kimlik bilgisi yok. Arayüz yeni sürümde İndirme Merkezi'nde şerit gösterir (sürüm sayfası yeni sekmede).
- Sınama: adres `OFFLINE_GUNCELLEME_URL` ile yerel sahte sunucuya yönlenir (`OFFLINE_GUNCELLEME_ILK_MS`, `OFFLINE_GUNCELLEME_ARALIK_MS` zamanlamayı kısaltır). Sınama kipinde (`OFFLINE_DATA_DIR`) bu adres yoksa ağa hiç çıkılmaz ve otomatik denetim kurulmaz.

### Klip (indirmeden önce 60 sn'lik örnek)
Bir kaynağın görüntü kalitesini indirmeden görmek için. Ayrıntı: `lib/klip.mjs`.
- Torrent **geçici** olarak motor havuzunda kendi rqbit sürecinde başlatılır (havuz anahtarı `klip:<infoHash>`; `GET /api/engines` bunu gösterir). Kütüphaneye/İndirilenler'e **eklenmez**, kalıcı kayıt yok. Yalnız seçilen dosya (`only_files`) `data/klipler/gecici/<iş>` klasörüne iner (indirme klasörüne değil). İndirme sınırı yok, yükleme sınırı ayarı uygulanır. Dosya kütüphanede zaten tamamsa motor açılmaz, diskteki dosyadan kesilir (`source: "disk"`).
- ffprobe rqbit akış adresinden (`/torrents/<ih>/stream/<idx>`, Range) süreyi ve akışları okur; ffmpeg sürenin **%30**'una girdi öncesi `-ss` ile atlar, `-t 60`, **`-c copy`** (yeniden sıkıştırma yok, kalite birebir): ilk video (kapak resmi değil) + ilk ses + altyazılar (metin ve PGS/VobSub kopyalanır, MP4 `mov_text` srt'ye çevrilir, diğerleri atlanır; altyazıyla kesilemezse altyazısız yeniden denenir) + ASS yazı tipleri → `.mkv`. Kopya kesim anahtar kareden başladığı için klip birkaç saniye uzun olabilir. MKV (Cues sonda) ve MP4 (moov sonda) yerel döngüde doğrulandı: rqbit, ffmpeg'in istediği bölgeleri öne alır.
- Bitince (başarılı/başarısız/iptal) geçici motor kapanır, geçici parçalar silinir. Klip `data/klipler/<id>.mkv` (+ `<id>.json`) olarak **24 saat** tutulur; servis açılışında ve saatte bir temizlenir; aynı içerik (aynı torrent ya da aynı film/bölüm kimliği) kütüphanede tamamlanınca silinir (dakikada bir ve `GET /api/klip`'te denetlenir).
- Aynı anda **tek iş**. Zaman aşımı 3 dk. Eş yoksa/torrent bilgisi gelmezse: "Bu kaynağın eşi yok ya da yanıt vermiyor; klip alınamadı."
- ffmpeg/ffprobe: Stremio 5'in kurulum klasöründekiler (kaldırma kaydı HKCU Uninstall, DisplayName "Stremio…" → InstallLocation; yoksa `%LOCALAPPDATA%ProgramsStremio`). `OFFLINE_FFMPEG` (ffmpeg.exe yolu ya da klasörü) verilirse yalnız o kullanılır. Stremio'nun dosyalarına yalnız okuma/çalıştırma.

Uçlar (`:id` 16 onaltılık karakter):
- `GET /api/klip` → `{ available, reason, ffmpegFrom, job, klips: [klip, …] }`. `available: false` ise `reason` açıklar (arayüzde düğme devre dışı). `job`: çalışan iş ya da `null`; `klips`: hazır klipler (en yeni önce).
- `POST /api/klip` gövde `{ infoHash, fileIdx, trackers?, type?, id? (Stremio kimliği), title?, fileName?, replace? }` → `201 { existed: false, job }`. Aynı kaynağın (infoHash + fileIdx) hazır klibi ya da süren işi varsa `200 { existed: true, job }`. Başka bir iş sürüyorsa `409 { err, job }`; `replace: true` eskisini iptal edip yenisini başlatır. ffmpeg yoksa `503`. `fileIdx: null` → en büyük video (bölümse o bölüm).
- `GET /api/klip/:id` → iş: `{ id, state, message, error, infoHash, fileIdx, type, videoId, title, fileName, source, downloadedBytes, peers, durationSec, startSec, lengthSec, doneSec, sizeBytes, startedAt, createdAt, expiresAt, fileUrl }`. `state`: `connecting` (bağlanıyor) → `downloading` (akış açıldı, `downloadedBytes`) → `preparing` (ffmpeg yazıyor, `doneSec/lengthSec`) → `ready` | `error` | `canceled`. Son 20 iş bellekte tutulur.
- `DELETE /api/klip/:id` → `{ ok: true }`: süren işi iptal eder, hazır klibi siler.
- `GET|HEAD /api/klip/:id/dosya` → klip (`video/x-matroska`, Range, `206`/`416`). Hazır değilse `409`.

Arayüz: sürüm seçicide inmemiş her satırda "🎬 Klip" (`web/klip.js`); ilerleme satırın altında, hazır olunca "▶ Klibi oynat". Gömülü kipte `oynat` iletisi `playUrl: <servis>/api/klip/<id>/dosya` ile gider (`inject.js` yalnız bu biçimi ve `/play/` adreslerini kabul eder) ve Stremio oynatıcısında **kütüphane kimliği olmadan** (`#/player/<akış>`) açılır: izleme geçmişine film olarak yazılmaz. Tarayıcıda (gömülü değil) `<video>` ile oynatılır, yanında dosya bağlantısı.

### Eski uçlar (inject.js ve eski panel için korunur)
- `POST /api/kapat` → `{ ok: true }`, ardından servis temiz kapanır (motor süreçleri de). Yalnızca kaynaksız yerel istek ya da servisin kendi sayfası; Stremio kökeni `403`. `durdur-servis.ps1` bunu kullanır (Windows'ta SIGTERM yoktur).
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

### Sürüm seçicide kalite rozeti
Her sürüm satırında indirmeden **tahmini ortalama bit hızı** (Mbps) gösterilir: Torrentio'nun bildirdiği boyut ÷ Cinemeta süresi (`/api/title` → `runtime`). Saf hesap `web/yardimci.js` (`parseRuntime`, `qualityBadge`, `techTags`; sınama `test/rozet.test.mjs`). Süre yoksa, sürüm sezon paketinden geliyorsa (`kind: pack`, boyut tüm paketin olabilir) ya da sonuç 120 Mbps'i aşıyorsa (koleksiyon boyutu) rozet yok. Renk, kalite grubuna göre (ses dahil ortalama; H.264 eşikleri, **HEVC/AV1'de ×0,6**):

| Kalite | düşük (kırmızı) | orta (sarı) | iyi (yeşil) |
|---|---|---|---|
| 2160p | < 12 | 12–25 | > 25 |
| 1080p | < 4 | 4–8 | > 8 |
| 720p | < 2 | 2–4 | > 4 |
| 480p | < 1 | 1–2 | > 2 |

Kalite bilinmiyorsa değer renksiz gösterilir. Yanında addan okunan etiketler: video codec (AV1, HEVC, AVC), HDR (DV, HDR10+, HDR), 10bit, ses (Atmos, TrueHD, DTS:X, DTS-HD, DTS, DDP, DD, AAC, FLAC, Opus) ve Torrentio etiketleri (REMUX, CAM). Bit hızı yalnız tahmindir: aynı bit hızında kaynak (BluRay/WEB) ve kodlayıcı kalitesi farkı görünmez; bunun için "Klip".

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
| `updateRepo` | `AcarPlus/stremio-offline` | güncelleme denetimi için GitHub deposu (`sahip/depo`) |
| `priorityThrottle` | 200000 | öncelik varken diğer etkin indirmelerin kısıldığı hız, ilk değer (sonrası `data/ayarlar.json`) |

UPnP kapalıdır (`--disable-upnp-port-forward`), DHT durumu diske yazılmaz (`--disable-dht-persistence`; aynı anda birden çok süreç böylece çakışmaz). Motor oturum kalıcılığı kapalıdır (`--disable-persistence`): doğruluk kaynağı `library.json` + `.torrent` önbelleği (`data/torrents/`); süreç her başladığında torrent aynı klasöre yeniden eklenip doğrulanır. Günlükler: kontrol `data/rqbit/rqbit.log`, indirme süreçleri `data/rqbit/motorlar/<yuva>/rqbit.log` (pid dosyası da orada); servis günlüğü `data/servis.log`. Eski tek oturum (`data/rqbit/oturum`) ilk açılışta `data/rqbit/oturum.v1-yedek` olarak kenara alınır.

## Ortam değişkenleri (sınama)

| Değişken | Etki |
|---|---|
| `OFFLINE_DATA_DIR` | Veri klasörü. Verilirse kökteki `config.json` **okunmaz/yazılmaz**, indirme klasörü varsayılanı `<veri>/indirilenler` olur. Sınama kipinde gerçek servisin kapı aralığına girilmesin diye `OFFLINE_PORT`, `OFFLINE_RQBIT_PORT`, `OFFLINE_PEER_PORT`, `OFFLINE_ENGINE_API_BASE`, `OFFLINE_ENGINE_PEER_BASE` **zorunludur** (eksikse servis hata verip açılmaz). |
| `OFFLINE_DOWNLOAD_DIR` | İndirme klasörünün ilk değeri (arayüzden kaydedilen klasör bundan önceliklidir) |
| `OFFLINE_KAPATMA_KOMUTU`, `OFFLINE_KAPAT_KONTROL_MS` | Bilgisayarı kapatma programı (sınama kipinde yoksa hiçbir şey çalışmaz) ve denetim aralığı |
| `OFFLINE_GUNCELLEME_URL`, `OFFLINE_GUNCELLEME_ILK_MS`, `OFFLINE_GUNCELLEME_ARALIK_MS`, `OFFLINE_GUNCELLEME_REPO` | Güncelleme denetimi adresi (sahte sunucu) ve zamanlaması; `updateRepo` karşılığı |
| `OFFLINE_KLASOR_SECICI` | `POST /api/klasor-sec` için sahte program (sınama kipinde yoksa pencere hiç açılmaz) |
| `OFFLINE_PORT`, `OFFLINE_RQBIT_PORT`, `OFFLINE_PEER_PORT` | Kapılar |
| `OFFLINE_PEER_LISTEN_IP` | `peerListenIp` (boş = rqbit varsayılanı) |
| `OFFLINE_TORRENTIO_URL`, `OFFLINE_METADATA_TIMEOUT`, `OFFLINE_RATELIMIT_DOWN`, `OFFLINE_RATELIMIT_UP` | Ayar karşılıkları (`downloadLimit`, `uploadLimit`: ilk değer) |
| `OFFLINE_ENGINE_API_BASE`, `OFFLINE_ENGINE_PEER_BASE`, `OFFLINE_ENGINE_SLOTS` | İndirme süreçlerinin kapı aralığı |
| `OFFLINE_RQBIT_EXE` | rqbit yolu (sınama) |
| `OFFLINE_LOOPBACK=1` | DHT/tracker/LSD kapalı (internetsiz sınama) |
| `OFFLINE_EXTRA_PEERS=ip:port,…` | Her eklemede/sürdürmede motora verilen eşler (sınama tohumlayıcısı) |
| `OFFLINE_NO_INJECT=1` | Stremio arayüzüne düğme ekleme kapalı |
| `OFFLINE_DEBUG_PORT` | Stremio hata ayıklama kapısı (`debugPort`). Sınama kipinde (`OFFLINE_DATA_DIR`) düğme ekleme yalnız bu verilirse açılır |
| `OFFLINE_STDIN_CONTROL=1` | stdin'den `kapat` satırı gelince temiz kapanır |
| `OFFLINE_POLL_MS` | Motor durum sorgu aralığı (vars. 1000) |
| `OFFLINE_FFMPEG` | Klip için ffmpeg.exe yolu ya da klasörü (ffprobe.exe yanında); verilirse yalnız o kullanılır |
| `OFFLINE_KLIP_TIMEOUT_MS`, `OFFLINE_KLIP_TTL_MS` | Klip işi zaman aşımı (vars. 180000) ve klibin saklanma süresi (vars. 24 saat) |

Sınamalar: `npm test` (yerel döngü, internetsiz; geçici klasörde çalışır, kullanıcı verisine dokunmaz).
