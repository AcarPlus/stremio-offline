# Faz 4 doğrulama raporu

Tarih: 2026-11-14. Kapsam: `3de4297..66466df` (5 commit). Bağımsız doğrulama; ürün kodu değiştirilmedi.

Yöntem: depoyu boşluklu bir yola klonladım (repo dışı geçici klasör), kendi `config.json`'umda ayrı portlar (11590/11591/11592) ve ayrı veri/indirme klasörü kullandım; üretimdeki kod yolunu (OFFLINE_DATA_DIR olmadan) böyle denedim. Tarayıcı olarak ayrı profilli başsız Edge (hata ayıklama kapısı 11591) + web.stremio.com. Kullanıcının servisine (11480), rqbit'ine (11482), Stremio'ya (11481), gerçek `data/` ve Videos klasörüne yazma/kapatma/yenileme yapılmadı; masaüstü, Başlat ve Başlangıç kısayolları tetiklenmedi, `kur.ps1`/`kaldir.ps1` gerçek konumlara karşı çalıştırılmadı (yalnız geçici klasör parametresiyle). Hiçbir indirme yapılmadı; "indiriliyor/indirildi" durumu sayfada `/api/items` yanıtı sahtelenerek denendi. Bitişte başlattığım süreçler kapatıldı, geçici veri silindi.

`npm test`: 45/45 geçti.

## Sonuçlar

| # | Madde | Sonuç |
|---|---|---|
| 1 | `npm test` | GEÇTİ (45/45) |
| 2 | İkinci örnek | GEÇTİ. Çalışan servisin ayarlarıyla ikinci `node server.mjs`: 0,08 sn'de çıkış kodu 0, rqbit pid dosyası ve rqbit sağlam, birinci çalışmayı sürdürdü. İki örnek aynı anda başlatılınca biri sessizce çıktı, tek rqbit kaldı, pid dosyası doğru. (Yanlışlıkla bir kez de kullanıcının gerçek servisine aynı portla vurdu: BOM'lu config nedeniyle, bkz. E10; ikinci örnek hiçbir şeye dokunmadan çıktı, kullanıcının servisi etkilenmedi.) |
| 3 | Gizli başlatma | GEÇTİ (kısmen). `wscript //B baslat-servis.vbs "<node>"` yolunda boşluk olan klasörde servis ve rqbit başladı, ana pencere tanıtıcısı 0; `baslat-stremio.vbs` → gizli PowerShell → servis + (sahte) Stremio başlattı, hata ayıklama argümanı yalnız o sürece geçti, kalıcı ortam değişkeni oluşmadı. Konsol penceresinin ekranda hiç görünmediği gözle doğrulanmadı. Node yolu bozuksa vbs sessizce çıkış kodu 0 verir ve hiçbir günlük yazmaz (E4). `kur.ps1` node'un mutlak yolunu kısayola yazar, PATH'e bağımlı değil. |
| 4 | Kısayollar | GEÇTİ. Üç `.lnk`: hedef `wscript.exe`, argüman `//B //Nologo "<repo>\baslat-*.vbs" "<node.exe>"`, çalışma klasörü repo, simge Stremio'dan. Var olan "Stremio.lnk" farklı ve dokunulmamış. `git grep` ile depoda kullanıcı adı ya da mutlak kullanıcı yolu yok (yalnız `$env:LOCALAPPDATA`). Commit kimliği noreply. `kaldir.ps1` yalnız argümanı kökü içerenleri siler; eşleşme kusurlu (E5). |
| 5 | Yasaklar | GEÇTİ. Kayıt defteri, kalıcı ortam değişkeni, zamanlanmış görev, hizmet, güvenlik duvarı, Stremio kurulum dosyaları: hiçbirine dokunan kod yok (grep + okuma). |
| 6 | stremio-baslat.ps1 | GEÇTİ (kod okuyarak, E2 ile). Sormadan kapatmaz: yalnız `Evet` cevabında `Stop-Process -Force`. `#/player` denetimi yok (düğmesiz açık Stremio'da kapı kapalı olduğundan yapılamaz; tek güvence sorudur). "Hayır" dalı: `exit 0`, hiçbir şey yapmaz. Pencerenin gerçekte öne gelip gelmediği ve "Hayır" dalı DENENEMEDİ (kullanıcının ekranında iletişim kutusu çıkardı). |
| 7 | Enjektör döngüsü | GEÇTİ. Stremio kapalıyken 30 sn: günlük 28→28 satır, çalışma kümesi 67,4→68,1 MB, tutamaç sabit, hata yok. Sayfada boşta 8 sn'de 0 DOM değişimi. Sürüm damgalı kopya, farklı sürümlü yeni betik gelince söküldü (`stop` 1 kez çağrıldı, açık pencere kalktı, tek giriş, tek stil). Damgasız Faz 3 betiği yüklüyken servis yeniden başlayınca yeni betik uygulanmadı (belgelendiği gibi), çift düğme oluşmadı; sayfa yenilenince yeni betik tek kopya geldi (E3). |
| 8 | İndirilenler girişi, D2 | GEÇTİ. Gezinme çubuğunda Library'den sonra giriş (6 geçiş turunda hep 1 adet, çoğalma yok); tıklayınca gömülü pencere `?embed=1#/indirilenler`, başlık "İndirilenler", Esc kapatır; film sayfasında sol üstte "İndirilenler" ve eylem çubuğunda "İndir"; `#/player/…` rotasında hiçbir öğe yok ve açık pencere kapanır. D2 (sahte veriyle): iniyor → "⬇ İniyor %40", inmiş → "✓ İndirildi" + "▶ Offline oynat"; tıklayınca sürüm seçici yerine İndirilenler açıldı. |
| 9 | D3, D4, D5 | D3 GEÇTİ (E6 ile): sürüm seçicide süzgeç 2160p/1080p/720p/Bilinmeyen, kalite sıralaması her iki yönde "Bilinmeyen" sonda. D4 GEÇTİ: hata kartında öneri bir kez, %0.0 gizli. D5 GEÇTİ: "kütüphaneden kaldırılır ve indirilen dosyalar diskten silinir… kutuyu işaretle". D1 DENENEMEDİ (kart menüsü oturumsuz Stremio'da yok); kod okuyarak: `pointerdown` + Esc + tetikleyiciye `pointerdown` makul, çelişki görülmedi. |
| 10 | Yeni sürüme geçiş | Toparlanma GEÇTİ, temiz durdurma yolu KALDI (E1). Servis `Stop-Process -Force` ile öldürülünce rqbit de gitti (yetim kalmadı bu ortamda), yeniden başlatınca kütüphane ve `error` kaydı korundu, motor 1 sn'de hazır; pid dosyası eski sürece sahip çıkmadı (`ownsPid`). Yarım dosya düzeyinde toparlanma için mevcut `cekirdek.test` (sert kapanış, baştan inmeme) geçti; ben indirme yapmadım. |

## Kusurlar

- **E1 (orta) — Servisi durdurmanın temiz yolu yok.** Beklenen: yeni sürüme geçerken servisi durduran bir komut/betik. Olan: ne HTTP kapatma ucu, ne betik var; Windows'ta SIGTERM yok, yani tek yol süreci zorla öldürmek (`shutdown()` hiç çalışmaz). Tek betik `kaldir.ps1 -ServisiDurdur`, kısayolları da siler. Üstelik eski (Faz 3) servis çalışırken yeni servis `alreadyRunning` ile hiç başlamaz; geçiş için eskisinin elle öldürülmesi şart. Öneri: `durdur.ps1` (yalnız 11480'i dinleyen süreç) ya da yerel `POST /api/kapat` (Host denetimli).
- **E2 (orta/düşük) — "Stremio düğmesiz açık" sorusunda varsayılan düğme "Evet".** `stremio-baslat.ps1` `MessageBox` çağrısı ilk düğmeyi (Evet) varsayılan bırakır; o sırada Enter'a basılırsa Stremio zorla kapanır (izlenen şey kesilir). Ayrıca iletişim kutusu gizli bir süreçten çıktığı için başka pencerelerin arkasında kalabilir (denenemedi), betik cevap beklerken sonsuza dek takılır. Öneri: `DefaultButton = Button2` (Hayır), `TopMost` sahip form.
- **E3 (düşük) — Damgasız eski betik yeni betiği engelliyor.** Yeniden üretim: sayfada Faz 3 `inject.js` (`window.__offlineIndir === true`) varken servis (yeni sürüm) yeniden başlar. Beklenen: yeni düğmeler. Olan: "İndirilenler" girişi sayfa yenilenene dek gelmez. Belgeli, çift düğme yok; ama kullanıcının şu anki durumu tam budur.
- **E4 (düşük) — Başlatıcı hataları günlüksüz.** `baslat-servis.vbs` bozuk/taşınmış node yolunda sessizce çıkış kodu 0 verir; servis `setLogFile`'dan önce çökerse (ör. içe aktarma hatası) kayıt yok. Kullanıcı yalnızca "servis açılmadı"yı görür.
- **E5 (düşük) — `kaldir.ps1` eşleşmesi kusurlu.** `$arg.Contains($root)`: önek çakışması (`...\stremio-offline-v2\baslat-stremio.vbs` işaretli kısayol silindi) ve büyük/küçük harfe duyarlı (aynı yolun büyük harfli yazımı "bu klasöre ait değil" diye atlandı). Öneri: ayrıştırılmış tam betik yolu karşılaştırması, `OrdinalIgnoreCase`.
- **E6 (düşük) — D3 yarım uygulanmış.** `web/app.js` 722–727: dizi "Bölüm bölüm" sekmesindeki kalite açılırı ham Torrentio değerlerini listeler (1226p, 4k/4K, scr…), `qualityGroup/qualityLabel` kullanılmıyor.
- **E7 (düşük) — D2 duraklatılmış/hatalı kısmen inmiş içerikte düğme "⬇ İndir".** Yalnız `downloading`/`resolving` "İniyor" sayılır; duraklatılmış film sürüm seçiciye gidiyor (sunucu yinelenen eklemeyi `existed` ile ayırıyor, yani zarar değil, yalnız yanıltıcı).
- **E8 (düşük) — Stremio zaten düğmeli açıkken kısayol hiçbir şey yapmaz**, pencereyi öne getirmez; ayrıca betik Stremio'yu repo kökü çalışma klasörüyle başlatır (özgün kısayol: kurulum klasörü). Etkisi denenemedi (gerçek Stremio'ya dokunmadım).
- **E9 (düşük) — Yarışta kaybeden örnek, çıkmadan önce `Library.load()` ve `MetaStore` çalıştırır.** Kazanan `library.json`'u yazarken denk gelirse kaybeden "okunamadı" günlüğü ve `.bozuk-<zaman>` kopyası üretebilir (kod okuyarak; dar pencere, veri kaybı yok). Port başka bir uygulamadaysa da günlüğe "servis zaten çalışıyor" yazıp çıkar (yanıltıcı).
- **E10 (düşük, Faz 4 dışı) — BOM'lu `config.json` sessizce yok sayılıp varsayılanlarla üzerine yazılır.** PowerShell 5 `Set-Content -Encoding utf8` BOM yazar; `JSON.parse` patlar, `loadConfig` varsayılanlara döner ve dosyayı ezer (kullanıcının ayarları gider). Sınamada kendi klonumda yaşadım.
- **Bilgi (I1) — Yerel ağ erişim izni.** Başsız Edge 157, `web.stremio.com`'dan `127.0.0.1` isteklerini bayrak olmadan engelledi (Chromium Yerel Ağ Erişimi). Stremio'nun WebView2'si şu an çalışıyor (Faz 3 canlı denemesi), ama WebView2 çalışma zamanı güncellenirse düğmeler "servis çalışmıyor" diyebilir.
- **Bilgi (I2) — Yapı uyarısı kalıcı.** Gezinme çubuğu 8 sn'den uzun yoksa çıkan uyarı kutusu, çubuk geri gelse de kapanmaz (yalnız elle kapanır); gerçek Stremio rotalarında tetiklenmedi.

Yüksek önemde kusur bulunmadı.

## Denenemeyenler

D1 (kart menüsü kapanışı), `stremio-baslat.ps1` iletişim kutusu ve "Hayır" dalı, gerçek Stremio/WebView2'de F5 ile sayfa yenileme, gerçek indirme + kesme senaryosu (kod ve `npm test` ile kapsandı), konsol penceresinin ekranda görünmemesi (yalnız pencere tanıtıcısı).

## Gözlem

Sınama sırasında kullanıcının gerçek servis günlüğünde 11:33 ve 11:35'te iki "Stremio arayüzüne düğmeler eklendi" satırı belirdi ve oturum sonunda 11481 artık dinlenmiyordu (Stremio kapanmış). Gerçek Stremio'ya hiçbir işlem yapmadım; bu kullanıcının kendi işlemi olmalı.

## Kullanıcının yeni sürüme geçmesi için en güvenli sıra

1. İndirilenler'de iniyor olan ve oynatılan bir şey yoksa başla (zorla kapatma, birkaç saniyelik ilerlemeyi kaybettirebilir; motor kaldığı yerden devam eder).
2. Eski servisi kapat: yalnız 11480'i dinleyen node sürecini öldür (ör. `Stop-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 11480).OwningProcess`); ada göre toplu kapatma yapma. Açık `baslat.cmd` penceresi varsa kapat.
3. Yeni servisi başlat: Başlat menüsündeki "Stremio Offline" kısayolu (servisi gizli başlatır).
4. Açık Stremio'daki eski betik yüzünden "İndirilenler" girişi için Stremio'yu kapatıp aynı kısayolla aç (ya da sayfayı yenile); ondan sonra servis her yeniden başlayışında betik kendiliğinden güncellenir.
