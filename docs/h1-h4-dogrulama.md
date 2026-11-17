# H1–H4 düzeltmelerinin bağımsız doğrulaması

Kapsam: `67c414d` (H2), `1ee3b68` (H1), `b376175` (sınama), `218952e` (H3+H4), `97880fc` (rapor notları). Yöntem: farkların okunması, test dosyalarının okunması, `npm test`. Ürün kodu değiştirilmedi; canlı servise, rqbit'e, Stremio'ya, gerçek `data/` ve Videos'a dokunulmadı; ayrı canlı deneme yapılmadı (testler zaten ayrı kapı/veri klasöründe canlı rqbit ile çalışıyor).

## npm test

- Koşu 1: 65/65 geçti (180,9 sn).
- Koşu 2: 62/65. Üç hata hepsi `gecis.test` içinde (ilk test 36 sn sürdü, normalde 11 sn). Bu koşu, benim bir önceki arka plan koşumla örtüşen başlatmamla çakışmış olabilir (testler aynı `%TEMP%\stremio-offline-sinama` klasörünü kullanır); kesin kanıtım yok. `gecis.test` tek başına çalıştırıldığında 3/3 geçti.
- Koşu 3 (tek başına, çakışmasız): 65/65 geçti (181,6 sn).
- Sonuç: kararsızlık kanıtlanmadı ama dışlanmadı; `gecis.test` paylaşılan klasör yüzünden eşzamanlı koşuda kırılgan. Aşağıda Y3.

## Hükümler

### H1 (veri almayan ★ diğerlerini kısıyordu) — KAPANDI
- `effectiveLimit` artık `priorityReceiving(p)` ister: durum `downloading`, `inEngine`, motor `live`, ve `flow.on` (son 10 sn içinde bayt ilerledi; 20 sn ilerleme olmayınca kalkar). `resolving` ya da `initializing` ★ kimseyi kısmaz; kartta `priorityIdle`.
- Kanıt: `veri-almayan.test` gerçek motorla ölçüyor: eşsiz (hayalet) ★ varken paket 1045 KB/sn (sınır 1 MiB), ★ film veri alınca paket 174 KB/sn. Birim testte sahte saatle eşikler (19 sn kalkmaz, 20 sn kalkar, tek artış yeniden başlatır). Poll'daki durum değişimlerinde (duraklat, doğrulama, hata, düşme, motor yeniden başlama) `flow` temizleniyor; kod okumasında salınım ya da sızıntı görmedim.
- Kenar: ★ indirme veri almıyorsa diğerleri sınırsız kayıtlı sınırlarında kalır, ★ işareti ve kayıt korunur. Doğru.

### H2 (oynatılan indirme kısılıyordu) — KAPANDI
- `servePlay` akış başında `streamBegin`, `res.on('close')` ile `streamEnd` (çift çağrıya karşı korumalı; `res.destroyed` yarışı da ele alınmış). `effectiveLimit` en başta `isPlaying` ise `{down:0, throttled:false}` döner: hem öncelik kısmasından hem kendi kayıtlı sınırından muaf; kayıtlı `downloadLimit` değişmez. Açık bağlantı varken süresiz, kapanınca `playGraceMs` (30 sn) sonra `poll` içinde `syncLimits` ile geri döner; süresi dolan kayıtlar poll'da silinir.
- Kanıt: `oynatma.test` gerçek motorla: kısılmış film 200 KB/sn sınırında, akış açılınca sınırsız (>1,2 MiB/sn), okuma bırakılıp bağlantı açık kalınca muafiyet sürer, kapanınca bekleme süresi, sonra yeniden 200000. Test süreyi 3 sn'ye kısıyor; 30 sn varsayılanı (`?? 30000`) ayrıca ölçülmedi ama kod tek satır. Oynatılan ★ olmayan öğe başkasını kısmaz (test: ★ paketin sınırı aynı).

### H3 (`Settings.set` yarım uygulama) — KAPANDI
- `set` önce tüm anahtarları `strictLimit` ile `next`e doğrular, sonra uygular; geçersizde hiçbiri bellekte/diskte/öğelerde değişmez. `Manager.setSettings` `set` hata verince `applyToAll` ve motor uygulamasına hiç ulaşmaz.
- Kanıt: `dogrulama.test` birinci test (üç kötü gövde, `applyToAll:true` dahil; ayarlar aynı, `ayarlar.json` oluşmadı, öğe sınırı değişmedi).

### H4 (sınır doğrulaması gevşek) — KAPANDI
- `strictLimit`: yalnız `typeof number` + `Number.isInteger` + (0 ya da 1000..4294967295). `applyToAll === true`. API ucu `setLimit` ve ayar alanları aynı kuralı kullanıyor; eski `parseLimit` yalnız dosyadan okuma ve eski kayıt onarımında kaldı (bilinçli).
- Kanıt: testte reddedilenler true/false/[]/' '/'0x10'/'1e3'/'5000'/'0'/1.5/1e-9/[5]/999/1/-1/4294967296/null/{}/'abc'; kabul 0, 1000, 4294967295, 750000. `NaN` ve `Infinity` JSON'da gelemez (null olur) ve `Number.isInteger` zaten eler. `applyToAll` `'true'`,`1`,`'yes'`,`[]`,`{}` yok sayılır.

## Yeni bulgular

- **Y1 (düşük)** — `flow.on` motor istatistik isteği başarısız olunca (404 dışı hata) güncellenmez: `poll` `continue` eder, `trackFlow` çağrılmaz. Motor yanıt vermez ama süreç ölü sayılmazsa ★ öğenin son `on=true` durumu kalır ve diğerleri kısılı kalır (motor yeniden başlayınca temizlenir). Zararı sınırlı; öneri: istatistik hatasında `flow.delete`.
- **Y2 (bilgi)** — Yavaş ama sürekli (20 sn'de bir bile bayt artan) ★ indirme diğerlerini kısmaya devam eder; bu tasarım gereği ("veri alıyor"). Eşik ayarlanamıyor.
- **Y3 (düşük, test)** — Testler `%TEMP%\stremio-offline-sinama` klasörünü ve kapı bloklarını paylaşır; iki `npm test` eşzamanlı koşarsa (gözlem: koşu 2'de `gecis.test` düştü) birbirini bozabilir. Tek koşuda sorun yok. Öneri: harness'te koşuya özel klasör.
- **Y4 (çok düşük)** — `strictLimit(-0)` `-0` döner (`JSON.parse('-0')`); JSON'a `0` yazılır, işlevsel fark yok.
- **Y5 (bilgi)** — `LIMIT_MIN=1000` `uploadLimit` ve `priorityThrottle` için de geçerli (1 KB/sn altı pozitif reddedilir); `ayarlar.json`'daki eski küçük değerler gevşek okunup korunur, dosya elle bozulursa API'den düzeltilene kadar sürer. Beklenen davranış.

## Sınayamadıklarım

Ayrı canlı servis denemesi yapmadım (testler gerçek rqbit ve servisle uçtan uca ölçüyor, ayrıca tekrar etmeyi gereksiz gördüm). 30 sn varsayılan bekleme süresi, gerçek oynatıcıyla (Stremio) akış davranışı, tarayıcıda arayüz notları ("Oynatılıyor", "veri almıyor"), gerçek ağ.
