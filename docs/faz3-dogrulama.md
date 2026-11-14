# Faz 2 + Faz 3 doğrulama raporu

Tarih: 2026-11-14. Bağımsız doğrulama. Başlamadan önce 11480/11481 dinlenmiyordu ve Stremio kapalıydı; canlı deneme yapıldı. Ayrı veri ve indirme klasörü (repo dışı geçici klasör), rqbit 11492. Stremio hata ayıklama kapısıyla açıldı. Ürün kodu değiştirilmedi. Sınama servisine benim eklemediğim indirme belirmedi (servis günlüğü denetlendi). Bitişte servis, rqbit, Stremio kapatıldı, geçici veri silindi.

`npm test`: 37/37 geçti.

## Sonuçlar

| Madde | Sonuç |
|---|---|
| Film sayfasında "İndir" görünür | GEÇTİ |
| Gömülü sürüm seçici açılır; Kapat ve Esc kapatır | GEÇTİ |
| Seçici sıralama (5 ölçüt), kalite süzme, dil süzme, satır bilgileri (kalite, GB, seeder, dil, site) | GEÇTİ (D3 notu) |
| "İndir" (Sintel 720p YTS indi, satır "İniyor" gösterdi) | GEÇTİ |
| "İndir + oynat" | DENENEMEDİ (satırda var; "Oynat" yolu İndirilenler'den denendi) |
| Yönetici: yüzde, hız, kalan süre, kaynak sayısı | GEÇTİ |
| Duraklat, sürdür | GEÇTİ |
| İptal (onay iletişimi, Vazgeç, İptal et; klasör temizlendi) | GEÇTİ |
| Sil (onaylı; indirme klasörü boşaldı) | GEÇTİ (D5 notu) |
| Özet şeridi (kullanılan, boş disk, hız, etkin) | GEÇTİ |
| Dizi: "Sezonu indir" → sezon seçici; paket seçince "7 bölüm · 4.52 GB"; bölüm işaretleyince 6/3.55, 5/2.92, 0/0.00 (İndir pasif), geri 7/4.52; "Bölüm bölüm" sekmesi | GEÇTİ (gerçek dizi indirmesi başlatılmadı; kütüphane boş kaldı) |
| Poster rozeti: biten "✓ Offline", inen "⬇ İniyor %x" (ana ekran "izlemeye devam" kartında) | GEÇTİ |
| Film sayfasında "Offline oynat" → Stremio oynatıcısı, video ilerledi (00:16 → 00:42 arası, çıkıldı) | GEÇTİ |
| İndirilenler "Oynat" → oynatıcı açıldı, video ilerledi | GEÇTİ |
| Kart üç nokta menüsü "Cihaza indir (offline)" göründü, tıklayınca servis çağrıldı ("Zaten indirilmiş" bildirimi) | GEÇTİ (D2 notu) |
| `error` durumlu kart (metadata zaman aşımı, Sürdür/İptal) | GEÇTİ (D4 notu) |
| Dar genişlik (375 px): İndirilenler, sürüm seçici, sezon seçici, bölüm bölüm; yatay taşma yok | GEÇTİ |
| Sayfa değişimi: 10 geçişte düğme çoğalmadı, gizli sayfada düğme kalmadı, `warnings` boş | GEÇTİ |
| Konsol hatası taraması | DENENEMEDİ (konsol olayları toplanmadı; yalnızca `warnings` ve istisnasız çalışma gözlendi) |
| Kütüphane sayfasında rozet | DENENEMEDİ (kullanıcının Stremio hesabına öğe eklemek gerekirdi; aynı kod ana ekranda geçti) |
| "İndir + oynat", telefon gerçek cihazı, internetsiz açılış | DENENEMEDİ |

## Kusurlar

- **D1 (orta/düşük):** Kart menüsünde "Cihaza indir" tıklanınca bildirim gösteriliyor ama Stremio menüsü açık kalıyor (`closeMenus` sentetik fare/Esc olayı Radix menüsünü kapatmıyor). Yeniden üretim: ana ekranda kartın üç nokta menüsü → "Cihaza indir". Beklenen: menü kapanır. Olan: menü açık, kullanıcı Esc basana kadar kalır.
- **D2 (düşük):** Film sayfasındaki "İndir" düğmesi içerik inmiş ya da iniyorken de aynı ("⬇ İndir"); durum yansımıyor ("Offline oynat" yalnız inmişte çıkıyor, iniyorken hiçbiri yok, inen dosyayı akıştan oynatma yolu yok). Rozet ve seçici satırı ise durumu gösteriyor.
- **D3 (düşük):** Kalite "1226p" ve "?" (Torrentio tanımadığı) süzgeçte ayrı düğme; "Kalite (düşükten yükseğe)" sıralamasında "?" kalitesi en başa geliyor, "1226p" gibi sayısal olmayanlar sıralamada ne kalitede sayıldığı belirsiz.
- **D4 (düşük):** `error` kartında aynı öneri iki kez yazıyor: "Sürdür ile yeniden denenebilir. “Sürdür” ile yeniden deneyebilirsin." (motor mesajı + arayüz eki). Kartta %0.0 de gösteriliyor.
- **D5 (düşük):** Sil iletişimi "kütüphaneden kaldırılır" diyor; dosyaların da diskten silineceğini yalnız onay kutusunun (bırak) varlığından anlıyorsun. Metin açık olmalı. Ayrıca iki ayrı öğe de "Sintel" başlığı taşıyor; iletişim torrent adını göstermiyor (aynı içeriğin iki sürümünde hangisi silinecek belirsiz).
- **D6 (bilgi):** Sezon paketlerinde Torrentio bildirimli boyutlar bazen mantıksız (ör. Rutracker 7 bölümlük sezon 55.31 GB, S01-S05 720p x265 paketi 2.19 GB). Arayüz bunu "torrent sitelerinin bildirdiği değerler" uyarısıyla belirtiyor; paket seçilince dosya listesinden gelen kesin toplam (4.52 GB) gösteriliyor. Kusur sayılmaz, kayıt için.

Yüksek önemde kusur bulunmadı.

## Gözlem
`GET /api/torrents/:id/files` ile paket seçimi torrenti kütüphaneye eklemiyor (liste temiz kaldı). Gerçek `data/` ve Videos altındaki klasöre dokunulmadı; Insidious'a dokunulmadı.
