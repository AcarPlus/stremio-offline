# v1.1.0 bağımsız doğrulama (dal `ozellikler`, uç f3f42f4)

Kod değiştirilmedi, commit edilmedi. Gerçek servise (11480), ana klasöre, gerçek `data/`'ya, gerçek kısayollara ve gerçek `shutdown.exe`'ye dokunulmadı.

## Sınama sonucu
- `npm test`: 143/143 geçti, 0 başarısız (tek koşu, ~304 sn).
- Arayüz bakışı (ayrı veri klasörü, kapı 11700, sahte Torrentio 11799, `OFFLINE_NO_INJECT=1`; iki süreç de kapatıldı): ana sayfada ayar şeridi (indirme klasörü, "Hepsi bitince bilgisayarı kapat", sürüm + "Güncellemeleri denetle" + "Otomatik denetle") görünüyor; sürüm seçicide her satırda kalite rozeti (örn. "25 Mbps", "9,2 Mbps · HEVC 10bit") ve "Klip" düğmesi (etkin) görünüyor; JS konsolunda hata yok. CSS kaybı/çift tanım yok (kullanılan tüm sınıflar stil.css'te var). Aşağıdaki YÜKSEK/ORTA-1 bu bakışta tarayıcıda yeniden üretildi.

## YÜKSEK
Yok. Gerçek kullanıcıya veri kaybı ya da istemeden bilgisayar kapanması yolu bulunmadı (ayrıntı "Doğrulanan güvenli noktalar").

## ORTA

### O1. "Hepsi bitince bilgisayarı kapat" anahtarı, onay penceresini 1 sn'den uzun okuyan kullanıcıda hiç açılmıyor (işlev hatası)
- `web/app.js:312-318` (change dinleyicisi), `web/app.js:297-299` (`setKapat`), `web/app.js:564` (her saniye `setKapat(await api('/api/kapat-zamanla'))`).
- Senaryo: kutuyu işaretle -> `onayla()` penceresi açılır; bu sırada `kapatKilit` henüz false (yalnız `kapatGonder` içinde true olur). 1 sn'lik yoklama sunucudan `armed:false` alır ve `kapatTik.checked = false` yapar. Kullanıcı "Aç"a basınca dinleyici `kapatGonder(kapatTik.checked)` çağırır = `enabled:false` gider. Tarayıcıda yeniden üretildi: kutu işaretlendi, 3 sn beklendi, "Aç" tıklandı; giden gövde `{"enabled":false}`, sunucu `kapali` kaldı. Kullanıcı hiçbir uyarı görmez, anahtar açılmamış olur (güvenli yönde hata: bilgisayar kapanmaz, ama özellik pratikte çalışmıyor).
- Öneri: işaretlenme anında `const iste = kapatTik.checked` yakala ve onayı beklerken `kapatKilit = true` yap (ya da `kapatGonder(true)` doğrudan çağır).

### O2. `/api/klip` POST + `replace:true` yarışı: iki eşzamanlı iş
- `lib/klip.mjs:264-289`. `await this.cancel(cur.id)` (satır 267) sırasında gelen ikinci bir `replace:true` isteği de aynı `cur`'u görür; ikisi de iptal sonrası devam edip `this.job`'u ayrı ayrı atar. İlk iş `this.job` referansından düşer: `cleanup()` (`running` yalnız son işi korur) ve `stop()` (yalnız `this.job`'u iptal eder) onu tanımaz; iki geçici motor/ffmpeg aynı anda koşar, "tek iş" kuralı bozulur. Arayüz tek tıklama yaptığı için pratikte nadir (iki sekme / çift tıklama).
- Öneri: `create` içinde iptal beklemesinden sonra `this.job` durumunu yeniden denetle ya da `create`'i bir söz zinciriyle (kilit) sıraya sok.

## DÜŞÜK

### D1. Motoru çöküp yeniden başlayan klip işi sessizce öldürülür
- `lib/manager.mjs:183` `onEngineRestarted`: kütüphanede olmayan `klip:<hash>` anahtarı için `pool.stop(ih)` çağrılır. Klip motoru çökerse yeniden başlar başlamaz kapatılır; iş `rw_timeout` (60 sn) ya da 3 dk zaman aşımıyla "Klip alınamadı/eş yok" hatasına düşer. Sızıntı yok, yalnız yanıltıcı hata iletisi.

### D2. `config.json` ilk açılışta yarım yazılabilir
- `lib/config.mjs:60-61`: sürüm 1.1.0'da DEFAULTS'a `updateRepo` eklendiği için geliştiricinin mevcut `config.json`'u ilk açılışta yeniden yazılacak (mevcut anahtarlar korunuyor: `{...DEFAULTS, ...fileCfg}`, BOM düşer, ortam değişkeni geçersiz kılmaları dosyaya yazılmıyor — bunlar doğru). Ancak yazma `writeFileSync` ile yerinde ve atomik değil; tam bu anda süreç/bilgisayar kesilirse dosya kesik kalır, sonraki açılışta "bozuk" sayılıp `.bozuk-<zaman>` yedeklenir ve `downloadDir` varsayılana (Videos\Stremio-Offline) döner. Yedek alındığı için veri kaybı yok, ama indirme klasörü sessizce değişir. Öneri: `Write-JsonDosya`'daki gibi `.yeni` + rename.

### D3. `ayarlar.json`'daki `downloadDir`, sonradan elle değiştirilen `config.json`/`OFFLINE_DOWNLOAD_DIR`'i ezer
- `lib/settings.mjs:52-54`. Arayüzden bir kez klasör seçildikten sonra `config.json`'daki `downloadDir` ve (gerçek kipte) `OFFLINE_DOWNLOAD_DIR` etkisiz kalır. Belgelenmeli; tasarım gereği olabilir.

### D4. Silmede boş üst klasör temizliği, seçilen klasör kök/üst düzeyse geniş
- `lib/manager.mjs:570-573`: boş alt klasörler `item.downloadDir`'e kadar `rmdir` ile temizlenir. `denetleKlasor` `D:\` gibi sürücü kökünü ya da `C:\Windows` gibi yolları kabul eder (`lib/klasor.mjs:160-183`). Yalnız boş klasörler silinir ve yalnız silinen dosyanın ata zinciri üzerinde; ciddi risk yok. Öneri: sürücü kökü / sistem klasörlerini reddet.

### D5. Kapatma: "hepsi bitince" anlamı
- `lib/kapat.mjs:113-123`. Açıkken biri tamamlanır, diğeri hata verir/kullanıcı duraklatırsa etkin kalmadığı için bilgisayar yine 60 sn geri sayımla kapanır (testte "duraklatılmışlar sayılmaz" diye bilinçli). Hata veren indirme kullanıcıyı beklemez. Geri sayım arayüzde görünür ve iptal edilebilir; tasarım kararı olarak belgeli, yalnız bilgi.

### D6. Güncelleme denetimi varsayılan AÇIK
- `lib/settings.mjs:50`, `lib/guncelleme.mjs:289-293`: ayar yoksa `true`; açılıştan 60 sn sonra ve 24 saatte bir `api.github.com`'a istek gider (yalnız bu adres; `User-Agent: stremio-offline`; sınama kipinde adres yoksa ağa çıkılmıyor — doğrulandı). "Offline" odaklı ürün için varsayılanın kapalı olması ya da ilk açılışta bilgilendirme düşünülebilir. Arayüzde onay kutusu var.

### D7. `kaldir.ps1 -ServisiDurdur` yalnız kapı + `server.mjs` komut satırına bakar
- `kaldir.ps1:30-37`: süreç, kök klasörü doğrulanmadan yalnızca 11480'i dinleyip komut satırında `server.mjs` geçtiği için durdurulur. Bu worktree'den (ya da ikinci bir kopyadan) çalıştırılırsa ana klasörün gerçek servisi durdurulur. (Motor kapatma ise yol-bazlı ve doğru.) Bu değişiklik v1.1.0'dan önce de vardı; yine de gerçek servisin yanında ikinci kopyada çalıştırmamak gerekir. Öneri: `CommandLine`'da `$root` yolunu da ara.

### D8. `kur.ps1` Başlangıç kısayolunu sahiplik denetimsiz üzerine yazar
- `kur.ps1:31`: `Stremio Offline Servis.lnk` başka bir kopyaya (başka kök) aitse bile yazılır ve `data\kurulum.json` yeni köke döner; diğer kopyanın `kisayol-onar.ps1`'i artık `kok` uyuşmazlığıyla sessizce çıkar. Masaüstü/menü kısayollarında bu denetim var (`Test-Bizim`), başlangıç kısayolunda yok. Yalnız iki kopyadan kur çalıştırılırsa.

### D9. `Test-StremioHedefi` geniş: `stremio*.exe`
- `ortak.ps1:93-97`. "Stremio.lnk" başka bir Stremio türevine (ör. `stremio-enhanced.exe`) gidiyorsa o da başlatıcıya çevrilir ve başlatıcı Stremio 5'i açar. Asıl hali yedeklenir ve `kaldir.ps1` geri döndürür, yani geri alınabilir; yalnız sürpriz davranış.

### D10. Arayüz: klip yeteneği önbelleği
- `web/klip.js:9-14`: `klipYetenek()` sayfa ömrü boyunca bir kez çağrılır; sonradan başka sekmede alınan klip/iş yeniden çizimde bilinmez (yalnız `KLIP_ISLER` yerel belleği). Etkisi küçük.

## Doğrulanan güvenli noktalar (kod incelemesi + sınama)

Kapatma
- Gerçek `shutdown.exe` yalnız `komutBul` (`lib/kapat.mjs:19-23`) `testMode=false` ve `OFFLINE_KAPATMA_KOMUTU` yokken döner; sınama kipinde değişken yoksa `null` (sahte geri sayım, hiçbir program çalışmaz). Kaynakta `shutdown.exe` yalnız bu dosyada geçiyor (test de denetliyor).
- Bellekte, kalıcı değil: servis yeniden başlayınca `kapali`. Açılışta `startup()` indirmeleri sürdürse bile anahtar kendiliğinden kurulmaz. `arm()` etkin indirme yoksa 409. Tetikleme için 2 ardışık "etkin yok" gözlemi + armedAt'ten sonra tamamlanmış en az bir indirme gerekir; hiçbiri tamamlanmadıysa anahtar bırakılır. Geri sayımda yeni indirme gelirse `shutdown /a` ile iptal. `completedAt` yalnız `onFinished` ve (null'a) `select` içinde yazılıyor; eski bitmiş öğeler yanlış tetiklemez.
- Klip motorları kütüphane öğesi değil (`etkin` yalnız `lib.all()` durumuna bakar): klip çalışırken "etkin indirme" sayılmaz, kapatmayı ne tetikler ne geciktirir; klip işi sürerken bilgisayar kapanabilir (kabul edilebilir).
- Yönetim uçları: Origin denetimi (yalnız kendi sayfası ya da kaynaksız yerel istek); Stremio kökeni yalnız `download`/`auto`/GET; `Host` denetimi DNS yeniden bağlamayı engelliyor. Başka bir web sayfası `POST /api/kapat-zamanla` yapamaz.

İndirme klasörü
- Eski öğelerin işaretlenmesi (`lib/manager.mjs:75`): Manager, `Settings` kurulduktan SONRA oluşturulur; `ayarlar.json`'da `downloadDir` olmadığı için `cfg.downloadDir` geliştiricinin `config.json`'daki değeridir; alanı olmayan eski öğeler o klasörle damgalanır ve kaydedilir. `outputFolder`'ı dolu öğeler (geçişten gelenler dahil) yeniden eklemede açık `outputFolder` kullanır, yani yeri değişmez. Yeni öğeler eklenme anındaki klasörle damgalanır; klasör değişince süren indirmenin motoru kendi `item.downloadDir`'iyle (`pool.mjs:100`, `engine.mjs:84`) çalışır, kontrol motoru yalnız `listOnly` yaptığı için etkilenmez.
- Silme: kök `item.downloadDir`'dir; her dosya `roots` (öğe klasörü, `outputFolder`, güncel klasör) içinde değilse silinmez ve günlüğe yazılır; yanlış klasör silinmiyor.
- Kayıtlı klasör kullanılamıyorsa (sürücü yok) `config.json`/varsayılana dönülür ve `ayarlar.json` ezilmez; `Settings.set` önce hepsini doğrular, `.tmp` + rename ile yazar.
- Seçici: sınama kipinde `OFFLINE_KLASOR_SECICI` yoksa 503 (gerçek pencere açılmaz); tek pencere kilidi; 5 dk zaman aşımı.

Kısayollar
- `kisayol-onar.ps1` `data\kurulum.json` yoksa ya da `kok` bu klasör değilse hemen çıkar; bekçi (`kisayol-bekci.mjs:222-224`) işaret yoksa betiği hiç başlatmaz ve izleyicileri kapatır; sınama kipinde varsayılan kapalı. Yeniden yazma kendi `fs.watch` olayını tetikler ama ikinci tur değişiklik yapmaz (IconLocation/WorkingDirectory okuma biçimi kısayol COM'unda yazılanla uyuşuyor, ayrıca doğrulandı: sonsuz döngü yok).
- Dokunulanlar yalnız kullanıcının masaüstü / Programs klasörlerindeki `Stremio.lnk` (ve `Programs\Stremio\Stremio.lnk`); hedefi `stremio*.exe` değilse ve argümanında bizim `.vbs` yolu yoksa "atlandı". Görev çubuğu `User Pinned` ve ortak klasörlere dokunulmuyor. Yedek (`kisayol-yedek.json`) değişiklikten önce yazılıyor, `Set-YedekKaydi` kaydı değiştirir (ikinci çalıştırmada asıl kaybolmaz çünkü artık Stremio hedefi değil). `kaldir.ps1` yedekten tüm alanları (hedef, argüman, çalışma klasörü, açıklama, simge, pencere stili, kısayol tuşu) geri yükler; `bizimOlusturdu` olanı siler; asıl hedef yoksa güncel Stremio'ya yönlendirir; işaret önce silinir. Eski "Stremio Offline.lnk" yalnız bizim `.vbs` yolu varsa silinir.

Klip
- Geçici dosyalar: `rm` yalnız `data/klipler` altında ve `data/klipler/gecici/<rastgele 16 hex>` altında; temizlikte `gecici` atlanıp ayrıca yalnız çalışmayan işlerin alt klasörleri silinir. İndirme klasörüne ya da kütüphane yollarına `rm` yok. Çalışan işin `<id>.part`/`<id>.mkv` dosyası `running` ile korunuyor.
- Motor: `finally` içinde `pool.stop('klip:<hash>')` (yuva `engines` haritasından düşer, kapı serbest), süreç ölene kadar (en çok 5 sn) beklenip geçici klasör silinir; `pool.ensure` 503/hata verse de `finally` güvenli. Kütüphaneye sızma yok: öğe oluşturulmuyor, sınırlar `limitsFor` ile (indirme 0, yükleme ayarı).
- ffmpeg/ffprobe: `exec` AbortSignal ile `kill()`; `stop()` `killChildren()` ve `process.on('exit')` ile; zaman aşımı 3 dk. Eşzamanlılık: tek iş (yalnız O2'deki yarış dışında); aynı kaynak için çifte başlatma "existed:true" döner.
- Uçlar `/api/klip*` Origin denetiminden sonra çalışıyor; kimlikler `^[a-f0-9]{16}$`; `infoHash` 40 hex; izleyici adresleri protokol süzgecinden geçiyor; `inject.js` yalnız `/api/klip/<16hex>/dosya`'yı oynatıyor.

Güncelleme
- Adres yalnız `https://api.github.com/repos/<updateRepo>/releases/latest` (ya da sınamada `OFFLINE_GUNCELLEME_URL`); sınama kipinde adres yoksa ağa çıkılmıyor (`adres()` null, `start()` erken dönüyor). Yanıt 1 MB ile sınırlı, etiket doğrulanıyor, bağlantı yalnız https ve yeni sekmede `noopener noreferrer`. Otomatik indirme/kurma yok.

Arayüz birleşimi
- `index.html` `klip.js`'i `app.js`'ten önce yüklüyor; `klip.js` yalnız çağrı anında `h/toast/onayla/oynat/absUrl/EMBED` kullanıyor (hepsi tanımlı). `yardimci.js` dışa aktarımı hem eski hem yeni işlevleri içeriyor; `app.js` çift tanım/çakışma yok; yeni `.rozet`, `.klipDurum`, `.klasor*`, `.kapat*`, `.guncel*`, `.yeniSurum` stilleri mevcut, eski öncelik/kısma stilleri (`.kisildi`, `.dugme.oncelik`) yerinde.
