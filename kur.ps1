# Otomatik başlatmayı kurar: yalnızca kullanıcının klasörlerindeki .lnk kısayollarına dokunur.
#   - Başlangıç klasörü : "Stremio Offline Servis" -> oturum açılınca servisi gizli başlatır
#   - Masaüstü + Başlat menüsü: TEK kısayol "Stremio" -> servisi (gerekirse) başlatır, Stremio'yu düğmeli açar.
#     Stremio'nun kendi "Stremio.lnk"'i varsa yerinde bizim başlatıcıya çevrilir (asıl hali data\kisayol-yedek.json'a
#     yazılır, kaldir.ps1 geri getirir); yoksa "Stremio.lnk" oluşturulur. Eski "Stremio Offline.lnk"'ler silinir.
#     Ortak (tüm kullanıcılar) klasörlerine ve görev çubuğuna sabitlenmiş kısayollara dokunulmaz.
#   - data\kurulum.json: kurulum işareti. Servis bunu görünce kisayol-onar.ps1'i düzenli çalıştırır (Stremio güncellenip
#     kendi kısayolunu yeniden yazarsa yine başlatıcıya çevrilir).
# Kayıt defteri, ortam değişkeni, zamanlanmış görev, hizmet, güvenlik duvarı ya da yönetici yetkisi kullanmaz.
# Geri almak için: kaldir.ps1. Yeniden çalıştırmak güvenlidir.
param(
    [string]$BaslangicKlasoru = [Environment]::GetFolderPath('Startup'),
    [string]$MasaustuKlasoru = [Environment]::GetFolderPath('Desktop'),
    [string]$BaslatMenusuKlasoru = [Environment]::GetFolderPath('Programs'),
    [string]$VeriKlasoru = ''
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'ortak.ps1')
$veri = if ($VeriKlasoru) { [IO.Path]::GetFullPath($VeriKlasoru) } else { Get-VeriKlasoru $root }

$node = Find-Node $root
if (-not $node) { throw 'Node.js bulunamadı (node\node.exe yok ve node komutu PATH içinde değil).' }
$stremio = Get-StremioExe
$simge = Get-KisayolSimgesi $stremio
if (-not (Test-Path -LiteralPath $stremio)) { Write-Warning "Stremio bulunamadı ($stremio); kısayollar yine de oluşturuluyor." }

# 1) Başlangıç: servis
if (-not (Test-Path -LiteralPath $BaslangicKlasoru)) { throw "Klasör yok: $BaslangicKlasoru" }
$servisLnk = Join-Path $BaslangicKlasoru 'Stremio Offline Servis.lnk'
Set-BizimKisayol $servisLnk $root 'baslat-servis.vbs' $node 'Offline İndir servisini oturum açılırken gizli başlatır' $simge
Write-Host "Oluşturuldu: $servisLnk"

# 2) Tek "Stremio" kısayolu (masaüstü + Başlat menüsü)
$sonuc = Invoke-StremioKisayolDuzeni $root $node $stremio $MasaustuKlasoru $BaslatMenusuKlasoru $veri -Olustur
$sonuc.degisiklikler + $sonuc.atlananlar | ForEach-Object { Write-Host $_ }
Remove-EskiKisayollar $root @($MasaustuKlasoru, $BaslatMenusuKlasoru) | ForEach-Object { Write-Host $_ }

# 3) Kurulum işareti (kisayol-onar.ps1 yalnız bu varsa çalışır)
Write-JsonDosya (Join-Path $veri $script:KurulumDosyasi) ([ordered]@{
    surum = 1
    kuruldu = (Get-Date).ToString('o')
    kok = $root
    node = $node
    klasorler = [ordered]@{ baslangic = $BaslangicKlasoru; masaustu = $MasaustuKlasoru; baslatMenusu = $BaslatMenusuKlasoru }
})
Write-Host 'Kuruldu. Bir sonraki oturum açılışında servis kendiliğinden başlar; Stremio için "Stremio" kısayoluna tıkla.'
