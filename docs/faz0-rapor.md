# Faz 0 raporu: rqbit ölçümü (KISMİ)

Durum: ağ yoğun sınamalar, kullanıcı izleme yaparken bant genişliğini tükettiği için yarıda kesildi. Yapılanlar ölçüldü; yapılmayanlar **ertelendi: ağ sınaması gece yapılacak** diye işaretlidir. Ölçülmeyen hiçbir madde "geçti" sayılmamıştır.

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

## Task B: rqbit işlevsel sınamalar

| # | Madde | Sonuç |
|---|---|---|
| 1 | Stream + Range, ~%70 seek TTFB | ertelendi: ağ sınaması gece yapılacak |
| 2 | Pause / resume | ertelendi: ağ sınaması gece yapılacak (uç noktalar listede var, çağrılmadı) |
| 3 | Süreç öldür, aynı oturum klasörüyle yeniden başlat | ertelendi: ağ sınaması gece yapılacak |
| 4 | Sintel dosya seçimi, sonradan değiştirme | ertelendi: ağ sınaması gece yapılacak (uç nokta var, çağrılmadı) |
| 5 | Delete (dosyalı) / forget | delete: **kısmen gözlendi** (`200 {}`); forget: ertelendi |
| 6 | Stats alanları | **gözlendi** (aşağıda) |
| 7 | Operasyonel bilgiler | kısmen (`--help` ve gözlemden); kalanı ertelendi |

### Kullanılan HTTP çağrıları (gerçek yanıtlar, kısaltılmış)

Sunucu başlatma (gerçekte kullanılan):
`bin\rqbit.exe server start --persistence-location data\bench\rq-session data\bench\rq-out`
Başlangıç logu: `Listening on TCP [::]:4240`, `started HTTP API at http://127.0.0.1:3030`, `will use JSON database: "data\\bench\\rq-session"`. Oturum klasöründe `session.json` oluştu.

**Torrent ekle (magnet)**
`POST http://127.0.0.1:3030/torrents`, gövde: magnet metni (ham). `?overwrite=true` ile de denendi, aynı çalıştı. Metadata çözülünce döner (~3,4 sn):
```
{"id":0,"details":{"id":0,"info_hash":"43519d14...49fa","name":"ubuntu-24.04.5.1-desktop-amd64.iso",
 "output_folder":"data\\bench\\rq-out\\","total_pieces":23844,
 "files":[{"name":"...iso","components":["...iso"],"length":6250332160,"included":true,
 "attributes":{"symlink":false,"hidden":false,"padding":false,"executable":false}}]},
 "output_folder":"data\\bench\\rq-out\\","seen_peers":null}
```
`id` sayısal; `{id_or_infohash}` ile infoHash de kullanılır (infoHash ile stats ve delete çağrıldı, çalıştı).

**İstatistik**
`GET http://127.0.0.1:3030/torrents/{id|infohash}/stats/v1`
```
{"state":"live","file_progress":[30441472],"error":null,"progress_bytes":30441472,
 "uploaded_bytes":0,"total_bytes":6250332160,"finished":false,
 "live":{"snapshot":{"downloaded_and_checked_bytes":30441472,"fetched_bytes":32587776,"uploaded_bytes":0,
   "downloaded_and_checked_pieces":117,"total_piece_download_ms":312785,
   "peer_stats":{"queued":3,"connecting":3,"live":0,"live_tcp":0,"live_utp":0,"live_socks":0,
     "live_seeders":0,"seen":788,"dead":782,"not_needed":0,"steals":22}},
  "average_piece_download_time":{"secs":2,"nanos":673376068},
  "download_speed":{"mbps":0.0,"human_readable":"0.00 MiB/s"},
  "upload_speed":{"mbps":0.0,"human_readable":"0.00 MiB/s"},
  "time_remaining":null}}
```
Alan eşlemesi: durum `state` (gözlenen değer yalnızca `live`; diğerleri denenmedi), hata `error`, indirilen/toplam `progress_bytes`/`total_bytes`, dosya başına `file_progress[]`, bitti `finished`, canlı hız `live.download_speed.mbps` (adı mbps ama birim MiB/s, `human_readable` öyle diyor), yükleme hızı `live.upload_speed`, peer sayısı `live.snapshot.peer_stats.live`, ETA `live.time_remaining` (yalnızca null görüldü; dolu biçimi görülmedi). `live` alanının torrent live değilken (paused/initializing) var olup olmadığı **sınanmadı**.

**Sil (dosyalarla)**
`POST http://127.0.0.1:3030/torrents/{infohash}/delete` -> `200`, gövde `{}`. Dosya silmenin tam doğrulaması yapılmadı (çıktı klasörü ayrıca elle temizlendi): **kısmi**.

**API listesi** (`GET http://127.0.0.1:3030/` çıktısı; çoğu çağrılmadı):
```
GET  /dht/stats | /dht/table | /metrics | /stats | /stream_logs
GET  /torrents | /torrents/playlist
GET  /torrents/{id_or_infohash} | /haves | /metadata | /peer_stats | /playlist | /stats/v1
GET  /torrents/{id_or_infohash}/stream/{file_idx}   ("Accepts Range header to seek")
POST /torrents                         magnet: / http:// / yerel dosya
POST /torrents/create | /torrents/resolve_magnet
POST /torrents/{id}/add_peers          newline-delimited
POST /torrents/{id}/delete             torrent'i unut + dosyaları sil
POST /torrents/{id}/forget             torrent'i unut, dosyaları tut
POST /torrents/{id}/pause | /start
POST /torrents/{id}/update_only_files  gövde {"only_files":[0,1,2]}
```
Stream+Range, pause/start, update_only_files, forget davranışı **test edilmedi**.

### Madde 7: operasyonel bilgiler

- API adresi/portu: `--http-api-listen-addr 127.0.0.1:PORT` (env `RQBIT_HTTP_API_LISTEN_ADDR`); varsayılan `127.0.0.1:3030` (gözlendi).
- İndirme klasörü: `server start` için zorunlu konumsal argüman `<OUTPUT_FOLDER>` (yoksa oluşturulur). Torrent başına farklı klasör için `POST /torrents` sorgu parametresi olması beklenir (yanıtta `output_folder` görünüyor); **sınanmadı**.
- Oturum/state klasörü: `--persistence-location <klasör>` (JSON, `session.json` oluştu, gözlendi); `--disable-persistence` kapatır. `--fastresume` (deneysel, checksum atlar) **sınanmadı**.
- Peer dinleme: `--listen-port` (varsayılan 4240, TCP+uTP), `--listen-ip` (varsayılan `::`), `--disable-tcp-listen`, `--disable-upnp-port-forward`. Peer portu API'den ayrıdır ve varsayılan olarak tüm arayüzleri dinler; "127.0.0.1'e bağla" yalnızca API için geçerli.
- Yükleme: `--ratelimit-upload <bps>`, `--ratelimit-download <bps>` var. Tamamlanınca yüklemenin sürüp sürmediği ve nasıl durdurulacağı **sınanmadı** (olası yollar: `pause`/`forget`, `--disable-tcp-listen`, upload ratelimit).
- Tracker: magnet'teki iki https `tr=` ile 59 peer'e ulaşıldı, ancak peer'lerin tracker'dan mı DHT'den mi geldiği ayrıştırılmadı. Seçenekler: `--trackers-filename` (her torrente ortak tracker listesi), `--disable-trackers`, `--disable-dht`, `--disable-lsd`.
- Diğer: `--concurrent-init-limit` (varsayılan 5), `--peer-limit`, `--bind-device` (Windows'ta desteklenmez), `--http-api-allow-create`.
- Bitmiş dosyanın düz dosya ve öngörülebilir yolda olması: yanıttaki `output_folder` + `files[].components` ile bekleniyor; tamamlanmış torrentle **doğrulanmadı**.
- Aynı infoHash iki kez ekleme: **sınanmadı**.
- "Metadata hiç gelmiyor" durumu: **sınanmadı**. `POST /torrents` metadata çözülene kadar bloklandığı için istemci tarafında zaman aşımı gerekecek.

## Task C: yerel sayfayı Stremio içinde gösterme

**Atlandı.** `stremio-shell-ng` çalışıyordu ama `http://127.0.0.1:11481/json/version` yanıt vermedi (debug portu kapalı); kural gereği Stremio kapatılmadı. Ayrıca koordinatör talimatıyla Stremio'ya hiç dokunulmadı. iframe/CSP/postMessage/CORS sonuçları: **ertelendi: ağ sınaması gece yapılacak** (ölçülmedi). Debug portlu açılış için kullanıcının launcher'ı kullanılmalı.

## Riskler ve tuhaflıklar

1. webtorrent bu ortamda hiç metadata alamadı (iki koşu). Sebep teşhis edilmedi; gece yeniden denenmeli.
2. rqbit peer portunu (4240) tüm arayüzlerde açar ve UPnP dener; Windows güvenlik duvarı istemi çıkabilir (bu koşuda sistem ayarına dokunulmadı).
3. rqbit DHT önbelleğini kullanıcı profili altında (`rqbit\dht\cache\dht.json`) tutar, proje `data\` dışına yazar; `--disable-dht-persistence` ile kapatılır. Aynı anda ikinci rqbit örneği DHT portunda çakışabilir.
4. Açılışta DHT bootstrap DNS çözümü bir kez "no such host" hatası verdi, sonra çalıştı.
5. `download_speed.mbps` alan adı yanıltıcı: değerler MiB/s.
6. `POST /torrents` metadata gelene dek bloklar; metadata gelmezse asılma riski.
7. Hız tek koşuda 0,8-6,9 MiB/s arasında dalgalandı; karşılaştırma için çok koşu gerek.
8. Test ISO'su 6,25 GB (istenen 2-6 GB aralığının hafif üstü); yalnızca ~0,5 GB indirildi ve silindi.

## Test edilmeyenler ve nedeni

Task B 1, 2, 3, 4, forget ve madde 7'nin "sınanmadı" denen kısımları, Task C'nin tamamı ve webtorrent'in hız/CPU/RAM ölçümü: **ertelendi: ağ sınaması gece yapılacak**. Neden: kullanıcı aynı anda içerik izlerken testler bant genişliğini tüketiyordu; koordinatör tüm ağ sınamalarının durdurulmasını istedi. Task C ayrıca Stremio debug portu kapalı olduğu için de atlanırdı.
