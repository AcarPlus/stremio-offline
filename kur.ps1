# Otomatik başlatmayı kurar: yalnızca kullanıcının klasörlerine .lnk kısayolları ekler.
#   - Başlangıç klasörü : "Stremio Offline Servis"  -> oturum açılınca servisi gizli başlatır
#   - Masaüstü          : "Stremio Offline"         -> servisi (gerekirse) başlatır, Stremio'yu düğmeli açar
#   - Başlat menüsü     : "Stremio Offline"         -> aynısı
# Kayıt defteri, ortam değişkeni, zamanlanmış görev, hizmet, güvenlik duvarı ya da yönetici yetkisi kullanmaz.
# Geri almak için: kaldir.ps1. Yeniden çalıştırmak güvenlidir (kısayollar üzerine yazılır).
param(
    [string]$BaslangicKlasoru = [Environment]::GetFolderPath('Startup'),
    [string]$MasaustuKlasoru = [Environment]::GetFolderPath('Desktop'),
    [string]$BaslatMenusuKlasoru = [Environment]::GetFolderPath('Programs')
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Önce paketle gelen taşınabilir Node (node\node.exe), yoksa PATH'teki node.
$yerelNode = Join-Path $root 'node\node.exe'
$node = if (Test-Path $yerelNode) { $yerelNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw 'Node.js bulunamadı (node\node.exe yok ve node komutu PATH içinde değil).' }
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$stremio = Join-Path $env:LOCALAPPDATA 'Programs\Stremio\stremio-shell-ng.exe'
$simge = if (Test-Path $stremio) { "$stremio,0" } else { "$env:SystemRoot\System32\shell32.dll,175" }

function New-Kisayol($klasor, $ad, $vbs, $aciklama) {
    if (-not (Test-Path $klasor)) { throw "Klasör yok: $klasor" }
    $yol = Join-Path $klasor ($ad + '.lnk')
    $sh = New-Object -ComObject WScript.Shell
    $k = $sh.CreateShortcut($yol)
    $k.TargetPath = $wscript
    $k.Arguments = "//B //Nologo `"$(Join-Path $root $vbs)`" `"$node`""
    $k.WorkingDirectory = $root
    $k.WindowStyle = 7
    $k.Description = $aciklama
    $k.IconLocation = $simge
    $k.Save()
    Write-Host "Oluşturuldu: $yol"
}

New-Kisayol $BaslangicKlasoru 'Stremio Offline Servis' 'baslat-servis.vbs' 'Offline İndir servisini oturum açılırken gizli başlatır'
New-Kisayol $MasaustuKlasoru 'Stremio Offline' 'baslat-stremio.vbs' "Stremio'yu Offline İndir düğmeleriyle aç"
New-Kisayol $BaslatMenusuKlasoru 'Stremio Offline' 'baslat-stremio.vbs' "Stremio'yu Offline İndir düğmeleriyle aç"
Write-Host 'Kuruldu. Bir sonraki oturum açılışında servis kendiliğinden başlar; Stremio için "Stremio Offline" kısayoluna tıkla.'
