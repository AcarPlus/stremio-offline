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

- `server.mjs`: yerel Stremio eklentisi (manifest, stream, catalog, meta) + indirme servisi (şimdilik webtorrent) + panel + Stremio'ya `inject.js` yükleyen bölüm. Adres `127.0.0.1:11480`.
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

## Çalışma kuralları

- Orkestratör oturum ürün kodu yazmaz. Zor iş Opus, kolay iş ve sınama Sonnet, çok basit iş Haiku alt ajanına verilir. Ajanlar sırayla çalışır.
- Her faz, onu yazan ajandan ayrı bir Sonnet ajanına doğrulatılır. Görsel sınama tek temada, en fazla 2–3 ekran görüntüsüyle yapılır.
- Her faz kendi commit'iyle biter. Push yapılmaz.
- Repoya kişisel veri girmez: isim, e-posta, kullanıcı klasörü yolları. Commit kimliği repo yerelinde ayarlıdır, değiştirilmez.
- Kullanıcının gerçek verisine sınamada dokunulmaz: `data/library.json` ve kullanıcının Videos altındaki indirme klasörü. Kullanıcı büyük bir indirmeyi bilerek durdurdu; sınamalar ayrı veri klasörü ve ayrı portla yapılır, o indirme sürdürülmez. Motor geçişinde eski kayıtlar "duraklatılmış" olarak taşınır.
- Sınamada yalnızca serbest lisanslı içerik kullanılır (Sintel, Linux kurulum dosyaları).
- Sistem ve güvenlik ayarı değiştirilmez. Yeni çalıştırılabilir dosya indirilmez; gerekirse kullanıcıya sorulur.
- Stremio açıksa ve adresi `#/player` içeriyorsa kullanıcı bir şey izliyordur: Stremio'ya dokunulmaz, sınama ertelenir.
