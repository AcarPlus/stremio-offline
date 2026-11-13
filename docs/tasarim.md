# Stremio Offline — tasarım ve yol haritası

Stremio 5 (Windows) için: Torrentio sonuçlarını cihaza indirip internetsiz izleten yerel eklenti + indirme servisi + Stremio arayüzüne eklenen düğmeler.

## Kararlar (2026-11-13, kullanıcıyla konuşuldu)

- **Motor:** rqbit (`bin/rqbit.exe`, v9.1.0). Faz 0 ölçümünden (hız, ileri sarma, kapat-aç sürdürme) geçerse kalır. Geçemezse qBittorrent; o durumda kullanıcıya sorulur (WebUI ayarı gerekir).
- **Arayüz:** tek bir "İndirme Merkezi" web sayfası, servis sunar. Stremio içinde pencere (iframe/overlay) olarak açılır; aynı sayfa telefon tarayıcısından da açılır. Faz 0 gömme denemesi olumsuzsa arayüz doğrudan Stremio DOM'una çizilir.
- **Film sayfası:** Stremio'nun normal sayfası açılır, içinde belirgin "İndir" düğmesi → sürüm seçici: kalite, boyut (GB), seeder, dil, kaynak site; sıralama ve filtre; her satırda "İndir" ve "İndir + oynat". Leecher gösterilmez.
- **İnmiş içerik:** İndirilenler ekranında tıklamak yerel dosyayı Stremio oynatıcısında açar. Stremio ana ekranında posterde rozet, film sayfasının en üstünde "Offline oynat".
- **Dizi:** "Sezonu indir" → sezon paketleri ve bölüm listesi. İndirmeden önce bölüm sayısı ve toplam GB görünür, bölümler tek tek işaretlenebilir. Disk limiti ya da üst sınır yok; karar kullanıcıda.
- **İndirme yöneticisi:** yüzde, anlık hız, kalan süre, boyut, toplam kullanılan ve boş disk; duraklat, sürdür, iptal, sil.
- **Seed:** indirme bitince yükleme yapılmaz.
- **Mobil:** Android. Hedef, dosyayı telefona alıp dışarıda izlemek (Faz 5: aynı Wi-Fi'da İndirme Merkezi'nden telefona indirme). Telefonun kendi başına indirmesi ayrı bir karar, kapsam dışı.
- **Paylaşım:** Faz 6'da tek klasör + tek tıkla kurulum paketi.

## Mevcut kod

- `server.mjs`: giriş noktası, adres `127.0.0.1:11480`. Modüller `lib/` altında (Faz 1): `engine` (rqbit alt süreci, sağlık izleme, yeniden başlatma), `manager` (indirme yöneticisi), `library` (kalıcı kütüphane, eski biçimden taşıma), `torrentio`, `addon` (Stremio uçları), `api` (arayüz API'si, belge: `docs/api.md`), `play` (oynatma), `meta`, `episodes`, `bencode`, `inject`.
- `web/`: İndirme Merkezi (Faz 2; `index.html`, `stil.css`, `app.js`). Servis kökünde sunulur; belge: `docs/api.md` "İndirme Merkezi arayüzü".
- `test/`: yerel döngü sınamaları (`npm test`).
- `inject.js`: akış sağ tık menüsüne ve kart üç nokta menüsüne "Cihaza indir" ekler. Stremio'nun hata ayıklama kapısı (11481) üzerinden yüklenir.
- `stremio-baslat.ps1`: servisi ve Stremio'yu kapı açık şekilde başlatır.
- `tools/cdp-eval.mjs`, `tools/cdp-run.mjs`: Stremio sayfasında JS çalıştıran yardımcılar.
- `docs/faz0-rapor.md`: motor ölçümü ve rqbit API başvurusu (Faz 0 çıktısı).

## Yol haritası

| Faz | İş | Model |
|---|---|---|
| 0 | Motor ölçümü, rqbit API dökümü, Stremio içine gömme denemesi | Sonnet |
| 1 | İndirme çekirdeği: motor geçişi; duraklat, sürdür, iptal, sil; canlı hız, yüzde, kalan süre, disk; sezon paketi ve bölüm çözümleme; hata olsa da kapanmayan servis | Opus |
| 2 | İndirme Merkezi sayfaları: sürüm seçici, sezon seçici, indirme yöneticisi, İndirilenler | Sonnet |
| 3 | Stremio bağlantısı: "İndir", "Sezonu indir", poster rozeti, "Offline oynat" | Opus |
| 4 | Kalıcı kurulum: kısayol, otomatik başlatma, internetsiz açılış testi | Sonnet |
| 5 | Android aktarımı (yerel ağ, telefona indirme) | Sonnet |
| 6 | Paylaşım paketi ve kılavuz | Sonnet |

Faz 3 doğrulandıktan sonra durulur ve kullanıcıya gösterilir; Faz 4 ve sonrası onun onayıyla başlar.

## Faz kapsamları (ajan görev tanımı için)

**Faz 1 — indirme çekirdeği (Opus).** Başvuru: `docs/faz0-rapor.md` (rqbit API ve tuhaflıkları), sınama düzeneği `tools/yerel-sinama/`.
- rqbit servisin alt süreci olur: servis başlatır, sağlığını izler, düşerse yeniden başlatır. rqbit durumu `data/` altında, API yalnızca 127.0.0.1'de.
- `server.mjs` modüllere bölünür: motor bağdaştırıcısı, indirme yöneticisi, Torrentio katmanı, Stremio eklenti uçları, arayüz API'si.
- İndirme yöneticisi: ekle (magnet + tracker'lar, dosya seçimi), duraklat, sürdür, iptal, sil; kalıcı kütüphane. Canlı durum: yüzde, anlık hız, kalan süre, bağlı kaynak, öğe boyutu, toplam kullanılan disk, boş disk. İndirme bitince torrent duraklatılır (yükleme yok).
- Eski kütüphane kayıtları yeni yapıya "duraklatılmış" olarak taşınır; kendiliğinden hiçbir şey inmeye başlamaz.
- Oynatma ucu: inmekte olan dosya rqbit akışından (Range ve ileri sarma), bitmiş dosya doğrudan diskten sunulur.
- Torrentio katmanı: film ya da bölüm için sürüm listesi (kalite, GB, seeder, dil, kaynak site); sezon için paket torrentleri ve bölüm bölüm seçenekler, bölüm sayısı ve toplam GB ile. Paket içindeki dosyalar bölümlere eşlenir.
- Arayüzün kullanacağı HTTP API `docs/api.md` içinde belgelenir (Faz 2 buna göre yazılır).
- Dayanıklılık: yakalanmamış hata servisi kapatmaz; metadata gelmeyen ekleme zaman aşımına uğrar ve kayıtta hata olarak görünür.
- Sınama için ortam değişkenleriyle ayrı port, ayrı veri klasörü ve ayrı indirme klasörü seçilebilir. Otomatik sınamalar yerel döngü düzeneğiyle çalışır.
- Mevcut Stremio eklenti uçları ve `inject.js` düğmeleri çalışmaya devam eder. Sık commit atılır.

**Faz 2 — İndirme Merkezi (Sonnet).** `docs/api.md`'ye göre, servisin sunduğu tek sayfalık arayüz; çatı kütüphane yok, koyu tema, Türkçe. Ekranlar: sürüm seçici, sezon seçici, indirme yöneticisi, İndirilenler. Hem tam sayfa hem Stremio içinde gömülü pencere olarak çalışır; telefonda da kullanılabilir genişlikte.

**Faz 3 — Stremio bağlantısı (Opus).** `inject.js`: film sayfasında "İndir", dizi sayfasında "Sezonu indir" düğmeleri İndirme Merkezi'ni gömülü pencere olarak açar; inmiş içeriklerin posterinde rozet; film sayfasının üstünde "Offline oynat"; İndirilenler'den tıklanan içerik Stremio oynatıcısında yerel dosyadan açılır. Seçiciler Stremio'nun sınıf adlarındaki rastgele eklere bağlı kalmaz; yapı değişmişse betik sessizce bozulmak yerine bunu bildirir. Gömme denemesi (Faz 0'dan ertelendi) bu fazın ilk işidir; iframe engelliyse arayüz ayrı pencerede açılır.

## Çalışma kuralları

- Orkestratör oturum ürün kodu yazmaz. Zor iş Opus, kolay iş ve sınama Sonnet, çok basit iş Haiku alt ajanına verilir. Ajanlar sırayla çalışır.
- Her faz, onu yazan ajandan ayrı bir Sonnet ajanına doğrulatılır. Görsel sınama tek temada, en fazla 2–3 ekran görüntüsüyle yapılır.
- Her faz kendi commit'iyle biter. Push yapılmaz.
- Repoya kişisel veri girmez: isim, e-posta, kullanıcı klasörü yolları. Commit kimliği repo yerelinde ayarlıdır, değiştirilmez.
- Kullanıcının gerçek verisine sınamada dokunulmaz: `data/library.json` ve kullanıcının Videos altındaki indirme klasörü. Kullanıcı büyük bir indirmeyi bilerek durdurdu; sınamalar ayrı veri klasörü ve ayrı portla yapılır, o indirme sürdürülmez. Motor geçişinde eski kayıtlar "duraklatılmış" olarak taşınır.
- Sınamada yalnızca serbest lisanslı içerik kullanılır (Sintel, Linux kurulum dosyaları).
- Sistem ve güvenlik ayarı değiştirilmez. Yeni çalıştırılabilir dosya indirilmez; gerekirse kullanıcıya sorulur.
- Stremio açıksa ve adresi `#/player` içeriyorsa kullanıcı bir şey izliyordur: Stremio'ya dokunulmaz, sınama ertelenir.
