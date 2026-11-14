# Faz 0 raporu: rqbit ölçümü (KISMİ; Task B tamamlandı)

Durum: Task A (hız, motor karşılaştırması) ve Task C (Stremio gömme) internet/Stremio gerektirdiği için **ertelendi: ağ sınaması gece yapılacak**. Task B (rqbit işlevsel sınamalar) Faz 0b'de internetsiz yerel döngüyle (127.0.0.1) tamamlandı. Ölçülmeyen hiçbir madde "geçti" sayılmamıştır.

Ortam: Windows 11, Node v26.13.0, rqbit 9.1.0 (`bin\rqbit.exe`), webtorrent ^3.0.21. Test torrent: ubuntu-24.04.5.1-desktop-amd64.iso (6,25 GB, infoHash `43519d14444904f6015e1a0d92018068fb0a49fa`, trackerlar: torrent.ubuntu.com, ipv6.torrent.ubuntu.com). Magnet, `.torrent` dosyasındaki bilgiyle üretildi (`data\bench\ubuntu.magnet`); yani metadata ağdan çözüldü.

## Task A: motor karşılaştırması

| Ölçüt | webtorrent | rqbit |
|---|---|---|
| Add -> metadata | **gelmedi**: 1. koşu 300 sn boyunca gelmedi; 2. koşu (yarıda kesildi) boyunca `peers 0`, `meta false`, uyarı "No nodes to query" | 3,4 sn (`POST /torrents` yanıtı metadata çözülünce döner) |
| Add -> ilk parça | gelmedi | 4,7 sn |
| 180 sn pencere ortalama hız | ölçülemedi | 2,70 MiB/s (510,9 MB / 180 sn) |
| Tepe hız | ölçülemedi | 6,89 MiB/s |
| Canlı peer (maks) | 0 | 59 |
| CPU (süreç, örnek ort.) | ölçülemedi | ~%4,5 (aralık %1,4-5,9) |
| RAM (working set, maks) | ölçülemedi | ~41 MB (34-43 MB) |

Notlar:
- webtorrent koşuları aynı ağda, rqbit'ten önce yapıldı ve ikisinde de metadata gelmedi. Sebep (Node 26 uyumu, DHT/UDP, magnet'te yalnızca https tracker olması vb.) **araştırılmadı**. Bu, webtorrent'in bu ortamda çalışmadığını gösterir, genel olarak kötü olduğunu değil. Adil karşılaştırma için gece tekrar edilmeli (`.torrent` dosyasıyla, klasik trackerlarla).
- rqbit tek koşu; hız swarm'a bağlı (2 MiB/s'de başlayıp peer sayısı arttıkça 4 MiB/s'ye çıktı). Tek ölçümle hız hükmü verilemez.
- Betikler: `data\bench\wt-bench.mjs`, `data\bench\rq-bench.mjs`; sonuç: `data\bench\rq-result.json`.

## Task B: rqbit işlevsel sınamalar (Faz 0b: yerel döngü, internetsiz)

Yöntem: internet trafiği üretilmeden, hepsi 127.0.0.1 üzerinde iki rqbit süreci. Tohumlayıcı (API 3051, peer 4251) deterministik sahte-rastgele yükleri sunar; indirici (API 3052, peer 4252) `--ratelimit-download` ile 4 MiB/s'ye kısılır, tohumlayıcıyı `initial_peers` ile bilir. DHT, tracker, LSD, UPnP kapalı. Yükler: 1,5 GB tek dosya (`Buyuk.Film.2160p.mkv`) ve 4x200 MB + `.srt` sezon paketi (`Show.S01`). Her şey `tools\yerel-sinama\` altındaki araçlarla yeniden üretilir (aşağıda "Yerel sınama araçları"). Aşağıdaki sonuçlar rqbit 9.1.0, Windows 11, Node 26 ile alındı; her madde `node tools\yerel-sinama\kontrol.mjs <no>` ile tekrarlanabilir.

| # | Madde | Sonuç |
|---|---|---|
| 1 | Stream + Range, ~%70 seek | **geçti** |
| 2 | Pause / resume | **geçti** |
| 3 | Öldür, aynı oturum klasörüyle yeniden başlat | **geçti** (iki tuzakla: peer'ler kalıcı değil, başlatılamayan torrent sessizce düşer) |
| 4 | Dosya seçimi, sonradan değiştirme | **geçti** |
| 5 | Delete (dosyalı) / forget | **geçti** |
| 6 | Ekleme yolları | **geçti**; "duraklatılmış ekle" HTTP'de yok (kaldı) |
| 7 | Metadata gelmeyen magnet | **kısmen**: istemci iptali ve temizlik doğrulandı; DHT'li sonsuz bekleme internetsiz üretilemedi, **ertelendi** |
| 8 | Tamamlanınca dosya ve yükleme | **geçti** |
| 9 | Çalışma anında limit değişikliği | **geçti (2026-11-14 düzeltmesi)**: `GET/POST /torrents/limits` var (süreç geneli); torrent başına yok |
| 10 | Operasyonel | **geçti** (güvenlik duvarı istemi gözlenemedi) |

### Ayrıntılı sonuçlar

**1. Stream + Range**
- `GET /torrents/0/stream/0`, `Range: bytes=0-1048575` -> `206`, `Content-Range: bytes 0-1048575/1572864000`, `Accept-Ranges: bytes`, `Content-Type: video/x-matroska`. İlk baytın gelişi 118 ms; gelen 1 MiB kaynak dosyayla **birebir aynı**.
- Aynı yol, `Range: bytes=1101017145-1102065720` (dosyanın %70'i; indirilen toplam o an 1 MiB'tı, yani o bölge kesinlikle inmemişti) -> `206`, **başlıklar anında, ilk gövde baytı 232 ms**, 1 MiB 480 ms'de tamam, bayt bayt kaynakla **aynı**. Aralık sonrası ilerleme 1 -> 6 MiB: seek parçaları öne alıyor ve birkaç parça ileriye okuyor. `file_progress` dosya başına ilerlemeyi parça sırasından bağımsız gösterir.
- Ardışık 8 MiB (limit 4 MiB/s) 2,0 sn; dosya sonu `bytes=1572863000-1572863999` doğru döndü; dosya boyutunun ötesi `416 {"human_readable":"bad range"}`; `Range` başlığı yoksa `200` + `Content-Length` + `Accept-Ranges: bytes`.
- Not: `GET .../haves` bitfield değil, SVG döndürür (görsel ilerleme çubuğu); parça haritası için kullanılmaz.

**2. Pause / resume**
- `POST /torrents/0/pause` -> `200 {}`. `state:"paused"`, ilerleme 5 sn boyunca 19,0 -> 19,0 MiB (durdu), `live:null`. Duraklatılmışken stream isteği 3 sn'de tek bayt vermedi (asılı kalır).
- `POST /torrents/0/start` -> `200 {}`, `state:"live"`, 26 -> 43 MiB (5 sn, ~4 MiB/s sınırı).
- Çift pause/çift start `400 {"human_readable":"torrent is already paused"}` / `"torrent is already live"`: idempotent değil, istemci durumu bilmeli veya 400'ü yutmalı.
- `GET /torrents` listesinde durum/ilerleme yok; yalnızca `id, info_hash, name, output_folder, total_pieces`. Durum için torrent başına `stats/v1` gerekir.

**3. Öldür / yeniden başlat** (`TerminateProcess`, yani temiz kapanış yok)
- Aynı `--persistence-location` ile yeniden başlayınca API 327 ms'de hazır; torrentler **kendiliğinden** geri geldi (liste sırası garanti değil: önce id 1, sonra 0).
- Yeniden doğrulama: `state:"initializing"`, ilerleme 96 -> 299 MiB sayarak; 450 MiB'lık torrent **1,85 sn**'de `live` (~250 MiB/s disk). İlerleme 450 -> 451 MiB: **yeniden indirme yok** (`fetched_bytes` bu oturumda 0). Kapanıştan önce duraklatılmış torrent **duraklatılmış** geldi (`is_paused` kalıcı); ama duraklatılmış torrentin `progress_bytes` değeri yeniden başlatma sonrası 0 göründü (doğrulama yapılmadığı için); gerçek ilerleme için torrent başlatılana dek güvenilmez.
- **Tuzak 1:** `initial_peers` kalıcı değil. Yeniden başlayan torrent `peer:0` ile bekler; `POST /torrents/0/add_peers` (gövde `127.0.0.1:4251\n`, yanıt `{"added":1}`) sonrası 41,9 MiB/s ile devam etti. Gerçek kullanımda tracker/DHT peer'leri geri getirir; tracker listesi `session.json` içinde tutulur.
- **Tuzak 2:** Çıktı dosyası açılamayan torrent (sınamada dosyanın yerine klasör koyuldu) yeniden başlatmada **sessizce API'den düştü**: `GET /torrents/{id}/stats/v1` -> `404 torrent not found`, tek iz günlükte (`ERROR ... error adding torrent to session ... os error 5`); `session.json` kaydı duruyor. Yönetici, başlatmadan sonra beklenen infohash listesini `GET /torrents` ile karşılaştırmalı.
- **id kararlılığı:** id'ler yeniden başlatmada **aynı** kaldı; torrent unutulunca id **yeniden kullanılmadı** (sonraki ekleme 2 aldı, o da yeniden başlatmadan sonra 2 kaldı). Yine de en güvenlisi infohash ile adreslemek: tüm uç noktalar `{id_or_infohash}` kabul ediyor.
- Oturum klasörü içeriği: `session.json` + her torrent için `<infohash>.torrent`.

**4. Dosya seçimi**
- Ekleme sırasında `?only_files=1` (dosya indeksi; tek değer denendi, birden çoğu için virgülle ayrılmış liste beklenir, `update_only_files` ise JSON dizisi alır; indeks sırası torrent içindeki sıradır: `E01.mkv, E01.srt, E02.mkv, E03.mkv, E04.mkv` -> 1 = `.srt`). Yanıt `files[].included` bunu yansıtır; `stats.total_bytes` yalnızca seçilenin toplamı olur (1 MiB), `finished` seçim bitince `true` olur.
- Diskte: seçilmeyen dosyalar **0 baytlık yer tutucu** olarak oluşturulur (`E01.mkv`, `E04.mkv` 0 bayt). Seçilen dosya **tam boyutta ve NTFS sparse** oluşturulur (200 MiB'lık dosya ilk saniyede 200 MiB görünür; **disk boyutu ilerleme göstergesi değildir**). Seçilen dosyayla parça sınırını paylaşan komşu dosyada en çok bir parça kadar bayt (1.048.536) oluşur.
- Sonradan değiştirme: `POST /torrents/0/update_only_files`, gövde `{"only_files":[1,2]}` -> `200 {}`; `E02` `included:true` oldu, ilerleme 1 -> 73 MiB, `total_bytes` 1 -> 201 MiB. Seçimi daraltma (`[2]`) da `200`: `srt` `included:false`. `GET /torrents/{id}` `files[].included` ile teyit edilir.
- `only_files_regex` **denenmedi** (aynı infohash zaten ekliydi, istek mevcut torrenti döndürdü).

**5. Delete / forget**
- `POST /torrents/{infohash}/forget` -> `200 {}`; torrent listeden çıktı, 5 dosya diskte **olduğu gibi** kaldı. `POST /torrents/{id}/delete` -> `200 {}`; dosyalar ve boşalan klasör silindi. `output_folder` içinde başka bir dosya varsa klasör ve o dosya **korunur** (yalnızca torrentin dosyaları silinir).
- Unutulmuş torrente `stats` -> `404`; olmayan torrente `delete` -> `500 "no such torrent in db"`.
- forget sonrası aynı torrenti aynı klasöre eklemek `overwrite` olmadan `400 error creating a new file (because allow_overwrite = false) ... (os error 80)`; `?overwrite=true` ile eklenir, mevcut veriyi yeniden doğrular ve **kaldığı yerden** sürer (forget öncesi 98 MiB, sonrası 100 MiB).

**6. Ekleme yolları** (`POST /torrents`, sorgu parametreleri: `overwrite, output_folder, sub_folder, only_files, only_files_regex, initial_peers, list_only, peer_connect_timeout, peer_read_write_timeout, is_url`)
- `.torrent` baytları gövdede (ham, content-type gerekmez): `200` ~4 ms. **Yerel dosya yolu gövdede kabul edilmez** (`400 error decoding torrent`); yalnızca bayt, `magnet:` veya `http(s)://` URL.
- Magnet + `initial_peers=127.0.0.1:4251`: `200` **5 ms**'de, metadata yerel peer'den geldi, indirme başladı (2,5 sn'de 13 MiB). DHT/tracker/peer yoksa magnet **hemen** `400 no known way to resolve peers (no DHT, no trackers, no initial_peers)` döner (bloklamaz).
- `list_only=true`: `200 {"id":null,"details":{...dosya listesi...}}`, torrent listeye **eklenmez**; magnet + peer ile de çalışır (1 ms). Sezon paketi önizlemesi için uygun.
- **Duraklatılmış ekleme: yok.** `paused=true` sessizce yok sayıldı (`state:"live"`). Çare: ekle, hemen `pause` (kısa bir yarış penceresi) ya da `list_only` ile önizle, karar sonra ekle.
- Aynı infohash'i ikinci kez eklemek (`.torrent` ile): `200`, **mevcut torrenti** (aynı id, eski `output_folder`) döndürür; ikinci istekteki `output_folder` yok sayılır. Liste uzunluğu değişmez.
- Çıktı klasörü: `output_folder=<yol>` verilirse dosyalar **doğrudan o klasöre** yazılır (çok dosyalıda `Show.S01` alt klasörü açılmaz). Verilmezse sunucunun çıktı klasörü + (çok dosyalıysa) torrent adı. `sub_folder=<ad>` sunucu çıktı klasörüne göredir, `output_folder` ile birlikte verilemez (`400 you can't provide both output_folder and sub_folder`).

**7. Metadata hiç gelmiyor**
- Eklemede sunucu tarafı zaman aşımı parametresi **yok**; ekleme metadata gelene kadar bloklar. Bu sırada API yanıt vermeye devam eder (`GET /torrents` 2 ms).
- **İstemci iptali çalışır:** Sessiz peer ile 4 sn sonra `AbortController` ile kesilen `POST /torrents` sonrası `GET /torrents` boş, `peers` hepsi 0, oturum klasörü boş, diskte iz yok (+1/+8/+15 sn'de de temiz). Yani ekleme isteği iptal edilince arkada torrent/peer **kalmıyor**.
- İnternetsiz üretebildiğim sınır durumları kendiliğinden biter: kapalı porta peer verilirse ~2 sn'de `400 input address stream exhausted, no way to discover torrent metainfo`; bağlanıp hiç konuşmayan peer ile varsayılan ayarda ~10 sn (okuma zaman aşımı) sonra aynı `400`. Sorgudaki `peer_connect_timeout`/`peer_read_write_timeout` **tam sayı** bekler (`2s` biçimi `400 invalid digit`; birimi denenmedi).
- **Ertelendi:** DHT/tracker açıkken peer arama sürdüğü için gerçek "hiç metadata gelmiyor" durumunda aynı `400`ün hiç gelmeyeceği beklenir; bu internetsiz üretilemedi. Öneri: istemci tarafı zaman aşımı (30-60 sn) + `AbortController`, gerekirse `list_only=true` ile önce çözmek. Yukarıdaki temizlik doğrulaması bu durumda da geçerli varsayılabilir ama **doğrulanmadı**.

**8. Tamamlanınca**
- Tamamlanan torrent: `state:"live"` (durum değişmez), `finished:true`, `time_remaining:null`. Dosyalar düz dosyadır; yolu `output_folder` + `files[].components` ile öngörülür; 4 `.mkv` + `.srt` SHA-1 ile kaynakla **birebir aynı**. Not: NTFS sparse bayrağı tamamlanmış dosyalarda da **kalır** (içerik/oynatma etkilenmez; kopyalama/taşıma araçları sorun çıkarmaz).
- **Yükleme tamamlanınca da sürer:** tohumlayıcı kapalıyken yalnızca bu örneğe bağlanan ikinci bir indirici 800 MiB'ın tamamını aldı (`uploaded_bytes` 800 MiB).
- Garanti yolları (her biri yeni bir indiriciyle sınandı):
  - `pause` -> 6 sn'de **0 bayt**, `state:"paused"`, `finished:true` korunur, `live:null`. Torrent listede kalır, `start` ile yeniden başlar (veri korunur). **Önerilen yol.**
  - `forget` -> 0 bayt, dosyalar diskte kalır, torrent yönetilmez olur.
  - `--ratelimit-upload 1` (bayt/sn, genel; yeniden başlatma gerekir) -> 8 sn'de 0,0 MiB; ama `--ratelimit-upload 0` **geçersiz**: `error: number would be zero for non-zero type`. Genel ayardır, per-torrent değil.
  - Önerilen kural: indirme biter bitmez (`finished:true`) `pause`; "Offline oynat" dosyadan okur, rqbit'e gerek yok.

**9. Çalışma anında limit ve stats**
- **Düzeltme (2026-11-14):** Faz 0b sınaması bu yolu denememişti. rqbit 9.1.0'da `GET /torrents/limits` → `{"upload_bps":null,"download_bps":null}` ve `POST /torrents/limits` (gövde JSON, `Content-Type: application/json` zorunlu, yoksa `415`) **süreç geneli** sınırı çalışırken değiştirir. Ölçüldü: birim **bayt/sn** (`download_bps: 1048576` → 1,00 MiB/s; 2097152 → 2,08 MiB/s); sınırsız = `null`; **gönderilmeyen alan da sınırsız olur** (her istekte iki alan birlikte gönderilmeli); `0`, ondalık ve dizge `422` ("expected a nonzero u32"). Başlangıç bayrakları (`--ratelimit-download`, `--ratelimit-upload`, bayt/sn, sıfırdan büyük) aynı değeri verir. **Torrent başına sınır HTTP'de yok**: `POST /torrents` sorgusunda `ratelimit_download`, `download_bps`, `ratelimits.download_bps`, `ratelimits[download_bps]`, `ratelimits={json}` denendi, hepsi sessizce yok sayıldı. Bu yüzden indirme başına sınır, indirme başına ayrı rqbit süreciyle yapıldı (bkz. tasarim.md). Aynı anda üç süreç DHT açık (`--disable-dht-persistence`) sorunsuz çalıştı: her biri rastgele bir UDP kapısında DHT açtı, `GET /dht/stats` routing tablosu 62/98/82.
- `GET /torrents/{id}/stats/v1` alanları (indirirken): `state` (gözlenen: `initializing`, `live`, `paused`; `error` durumu üretemedim), `error` (hep `null` görüldü), `progress_bytes`, `total_bytes` (seçime göre), `finished`, `file_progress[]`, `uploaded_bytes`, `live` (`paused` iken `null`) içinde: `download_speed.mbps` (**birim MiB/s**: 4 MiB/s limitte `3.997` ve `"4.00 MiB/s"`; alan adı yanıltıcı, yeniden teyit), `upload_speed`, `snapshot.peer_stats.live` (peer), `snapshot.fetched_bytes`, `time_remaining` = `{"duration":{"secs":371,"nanos":483000000},"human_readable":"6m 11s"}` (bitince `null`).
- `GET /stats` genel hız/peer/sayaç; `GET /torrents/{id}/peer_stats` peer başına sayaç.

**10. Operasyonel** (bkz. "rqbit API başvurusu")
- Güvenlik duvarı: sınama süreçleri yalnızca 127.0.0.1'e bağlandı; ekranda bir istem **gözlemleyemedim** (görsel denetim yapılmadı) ve Windows Güvenlik Duvarı kural listesinde `rqbit` adlı kayıt görünmedi (yönetici yetkisiyle sorgulanmadı). Güvenlik duvarına dokunulmadı. Gerçek ağ açılışında (`--listen-ip` varsayılan) istem çıkabilir, ayrıca denenmeli.
- `--disable-dht` iken bile rqbit rastgele bir UDP portunu `0.0.0.0` ve `[::]` üzerinde açtı (netstat), `--listen-ip 127.0.0.1` bunu kapatmadı.
- Kullanıcı profilindeki DHT önbelleği (`rqbit\dht\cache\dht.json`) bu oturumdaki hiçbir süreç tarafından değiştirilmedi (son yazım önceki koşuya ait). DHT açıkken `--disable-dht-persistence` ile aynı sonuç **doğrulanmadı** (ağ gerektirir). Oturum klasörü dışında profile başka yazım görülmedi.

### rqbit API başvurusu

Süreç (gerçekte kullanılan biçim; **genel seçenekler `server`'dan önce** gelir):
```
bin\rqbit.exe --http-api-listen-addr 127.0.0.1:PORT --listen-ip 127.0.0.1 --listen-port 4240 ^
  --disable-upnp-port-forward --disable-dht-persistence [--disable-dht --disable-trackers --disable-lsd] ^
  [--ratelimit-download BAYT_SN] [--ratelimit-upload BAYT_SN] --log-file data\rqbit\rqbit.log ^
  server start --persistence-location data\rqbit\oturum data\rqbit\cikti
```
Gerçek internet kullanımında `--listen-ip` verilmez (varsayılan `::`), DHT/tracker açık kalır. API'ye hazır olma: `GET /` `200`. Açılış ~0,3 sn.

| İş | Çağrı | Not |
|---|---|---|
| Ekle (`.torrent`) | `POST /torrents?output_folder=..&only_files=1&initial_peers=ip:port&overwrite=true` gövde: ham `.torrent` baytları | yanıt `{"id","details":{"info_hash","name","output_folder","files":[{name,components,length,included}]}}` |
| Ekle (magnet) | aynı, gövde `magnet:?xt=urn:btih:..` | metadata gelene dek bloklar; istemci zaman aşımı şart |
| Önizle | `?list_only=true` | `id:null`, eklenmez |
| Liste | `GET /torrents` | yalnızca kimlik/ad/klasör |
| Ayrıntı | `GET /torrents/{id\|infohash}` | `files[].included` |
| Durum | `GET /torrents/{id\|infohash}/stats/v1` | alanlar madde 9 |
| Duraklat/sürdür | `POST .../pause`, `POST .../start` | tekrar çağrı `400` |
| Seçim | `POST .../update_only_files` `{"only_files":[..]}` | |
| Unut (dosyalar kalır) | `POST .../forget` | |
| Sil (dosyalarla) | `POST .../delete` | |
| Peer ekle | `POST .../add_peers` gövde `ip:port\n` | `{"added":1}` |
| Akış | `GET .../stream/{dosya_idx}` + `Range` | `206`; duraklatılmışken asılır |

Hata biçimi: `{"error_kind","human_readable","status","status_text"}`; bilinmeyen torrent `404`, diğer hatalar çoğunlukla `400`/`500`. Torrent dosya sırası torrent içindeki sıradır. `only_files` ve `update_only_files` indeks kullanır.

### Yerel sınama araçları (`tools\yerel-sinama\`)
- `fixture.mjs`: `data\bench-yerel\kaynak\` altında deterministik yükleri (1,5 GB + 4x200 MB + `.srt`; `--kucuk` ile 1/10) ve tracker'sız `.torrent` dosyalarını üretir (~4 sn).
- `rq.mjs`: yerel tohumlayıcı/indirici başlatma (`tohumla()`, `indirici()`), `http()`, `stats()`, bütün süreçleri durdurma.
- `kontrol.mjs <no...>`: 1-9 numaralı kontrolleri çalıştırır, istek/yanıtları yazdırır. Çıktılar `data\bench-yerel\` (gitignore) altına yazılır; iş bitince bu klasör silinir.

## Task C: yerel sayfayı Stremio içinde gösterme

**Atlandı.** `stremio-shell-ng` çalışıyordu ama `http://127.0.0.1:11481/json/version` yanıt vermedi (debug portu kapalı); kural gereği Stremio kapatılmadı. Ayrıca koordinatör talimatıyla Stremio'ya hiç dokunulmadı. iframe/CSP/postMessage/CORS sonuçları: **ertelendi: ağ sınaması gece yapılacak** (ölçülmedi). Debug portlu açılış için kullanıcının launcher'ı kullanılmalı.

## Riskler ve tuhaflıklar

1. webtorrent bu ortamda hiç metadata alamadı (iki koşu). Sebep teşhis edilmedi; gece yeniden denenmeli.
2. rqbit peer portunu (4240) varsayılan olarak tüm arayüzlerde açar ve UPnP dener; `--listen-ip 127.0.0.1 --disable-upnp-port-forward` bunu kısıtlar, ama `--disable-dht` iken bile rastgele bir UDP port `0.0.0.0`/`[::]` üzerinde açılır. Güvenlik duvarı istemi gözlenemedi (sistem ayarına dokunulmadı).
3. rqbit DHT önbelleğini kullanıcı profili altında (`rqbit\dht\cache\dht.json`) tutar, proje `data\` dışına yazar; `--disable-dht-persistence` ile kapatılır. Aynı anda ikinci rqbit örneği DHT portunda çakışabilir; **`--disable-dht-persistence` ile çakışmadığı 2026-11-14'te ölçüldü** (üç süreç, her biri rastgele UDP kapısı).
4. Açılışta DHT bootstrap DNS çözümü bir kez "no such host" hatası verdi, sonra çalıştı.
5. `download_speed.mbps` alan adı yanıltıcı: değerler MiB/s.
6. `POST /torrents` metadata gelene dek bloklar; sunucu tarafı zaman aşımı yok. İstemci iptali temiz bırakıyor (madde 7), DHT'li gerçek sonsuz bekleme ertelendi.
- (Faz 0b) Başlatılamayan torrent yeniden başlatmada API'den sessizce düşer (yalnızca günlükte `ERROR`); `initial_peers` kalıcı değil; HTTP'de duraklatılmış ekleme yok; çalışma anında hız limiti yalnızca süreç geneli değiştirilebilir (`/torrents/limits`, sonradan bulundu); seçilen dosyalar diskte tam boyutta sparse görünür.
7. Hız tek koşuda 0,8-6,9 MiB/s arasında dalgalandı; karşılaştırma için çok koşu gerek.
8. Test ISO'su 6,25 GB (istenen 2-6 GB aralığının hafif üstü); yalnızca ~0,5 GB indirildi ve silindi.

## Test edilmeyenler ve nedeni

**ertelendi: ağ sınaması gece yapılacak:** gerçek swarm'da hız karşılaştırması ve webtorrent metadata hatasının teşhisi (Task A), DHT/tracker açıkken "hiç metadata gelmiyor" davranışı (Task B madde 7), `--disable-dht-persistence`'ın DHT açıkken profile yazımı engellediğinin doğrulanması, `only_files_regex`, birim doğrulanmamış `peer_*_timeout` parametreleri, `--fastresume`, Task C'nin tamamı (Stremio debug portu kapalıydı; iframe/CSP/postMessage). Neden: kullanıcı aynı anda içerik izlerken ağ sınamaları bant genişliğini tüketiyordu; Task B bu yüzden internetsiz yerel döngüyle yapıldı.
