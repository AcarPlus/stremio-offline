# Kısayol onarımı (sessiz, tekrar tekrar çalıştırmak güvenli). Servis bunu düzenli çalıştırır (lib/kisayol-bekci.mjs).
# Yalnız kur.ps1'in yazdığı kurulum işareti (data\kurulum.json) varsa ve bu klasöre aitse bir şey yapar;
# yoksa (kurulmamış kopya, sınama kopyası, kaldırılmış kurulum) hiçbir kısayola dokunmaz.
#   - Stremio güncellenince kurulum programı kendi "Stremio.lnk"'ini yeniden yazar (doğrudan Stremio programına):
#     yine bizim başlatıcıya çevrilir, asıl hali yedeğe (data\kisayol-yedek.json) yazılır.
#   - Stremio programının yeri değiştiyse bizim kısayolların simgesi düzeltilir.
#   - Başlangıç kısayolu ("Stremio Offline Servis") silinmişse YENİDEN OLUŞTURULMAZ (kullanıcı kaldırmış olabilir);
#     yalnız bir kez günlüğe yazılır.
#   - Yeni kısayol oluşturmaz (kullanıcının sildiği "Stremio" kısayolu geri gelmez).
# Değişiklikler ve hatalar data\baslatici.log'a yazılır. Klasörler kurulum işaretinden okunur.
param([string]$VeriKlasoru = '')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'ortak.ps1')
$veri = if ($VeriKlasoru) { [IO.Path]::GetFullPath($VeriKlasoru) } else { Get-VeriKlasoru $root }
function Yaz($metin) { Add-BaslaticiGunluk $veri 'kisayol-onar.ps1' $metin }
# kaldir.ps1 işareti bu arada sildiyse yeniden yaratılmaz.
function Save-Kurulum { if (Test-Path -LiteralPath $kurulumYolu) { Write-JsonDosya $kurulumYolu $kurulum } }
trap { Yaz ('HATA: ' + $_.Exception.Message + ' (' + $_.InvocationInfo.PositionMessage.Trim() + ')'); exit 1 }

$kurulumYolu = Join-Path $veri $script:KurulumDosyasi
$kurulum = Read-JsonDosya $kurulumYolu
if (-not $kurulum -or -not $kurulum.klasorler) { exit 0 }
# Klasör taşınmış (kurulum başka bir yerde yapılmış): kısayollar zaten eski yere gider; kur.ps1 yeniden çalıştırılmalı.
if (-not $kurulum.kok -or ([IO.Path]::GetFullPath("$($kurulum.kok)") -ine [IO.Path]::GetFullPath($root))) { exit 0 }

$node = "$($kurulum.node)"
if (-not $node -or -not (Test-Path -LiteralPath $node)) { $bulunan = Find-Node $root; if ($bulunan) { $node = $bulunan } }
$exe = Get-StremioExe
$k = $kurulum.klasorler

$sonuc = Invoke-StremioKisayolDuzeni $root $node $exe "$($k.masaustu)" "$($k.baslatMenusu)" $veri
foreach ($d in $sonuc.degisiklikler) { Yaz $d }

# Başlangıç kısayolu: varsa ve bizimse simgesi/node yolu güncel tutulur; yoksa yalnız bir kez bildirilir.
$servisLnk = [IO.Path]::Combine("$($k.baslangic)", 'Stremio Offline Servis.lnk')
$bildirildi = [bool]$kurulum.servisKisayoluYokBildirildi
if (Test-Path -LiteralPath $servisLnk) {
    $simge = if (Test-Path -LiteralPath $exe) { "$exe,0" } else { $null }
    if ((Test-Bizim (Get-KisayolBilgi $servisLnk).Arguments $root) -and -not (Test-BizimGuncel $servisLnk $root 'baslat-servis.vbs' $node $simge)) {
        Set-BizimKisayol $servisLnk $root 'baslat-servis.vbs' $node 'Offline İndir servisini oturum açılırken gizli başlatır' $simge
        Yaz "guncellendi: $servisLnk"
    }
    if ($bildirildi) { Set-Ozellik $kurulum 'servisKisayoluYokBildirildi' $false; Save-Kurulum }
} elseif (-not $bildirildi) {
    Yaz "Baslangic kisayolu yok ($servisLnk); yeniden olusturulmadi (kullanici kaldirmis olabilir). Geri istenirse kur.ps1 calistirilmali."
    Set-Ozellik $kurulum 'servisKisayoluYokBildirildi' $true
    Save-Kurulum
}
exit 0
