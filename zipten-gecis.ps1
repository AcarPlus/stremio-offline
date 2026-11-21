# Kurulum programı (exe) bunu kur.ps1'den önce çalıştırır (ilk kurulumda ve her güncellemede): bu kullanıcıda eski bir
# zip/klasör kurulumu varsa yeni kuruluma taşır.
# Eski kurulum şuralardan aranır (ilk bulunan, yeni kurulum dışındaki, içinde server.mjs olan klasör):
#   - Başlangıç klasöründeki "Stremio Offline Servis" kısayolu (oturum açılınca başlat kapalıysa yoktur),
#   - Masaüstü / Başlat menüsü / görev çubuğundaki "Stremio*" kısayollarından baslat-stremio.vbs'e gidenler,
#   - çalışan servis (komut satırında server.mjs olan node süreci).
#   1) Eski klasörün kaldir.ps1'i çalışır: eski servis durur, Stremio kısayolları asıllarına döner (kur.ps1 yeniden çevirir).
#   2) Yeni kurulumun kütüphanesi yoksa ya da boşsa eski veriler kopyalanır: library.json, torrents, meta, img;
#      ayarlar.json ve config.json yalnız yeni kurulumda yoksa. Kısayol yedeği, kurulum işareti, motor ve klip klasörleri,
#      günlükler kopyalanmaz. Eski klasör silinmez.
# İndirilen filmler yerinde kalır (kütüphane mutlak yolları tutar). Yeniden çalıştırmak güvenlidir.
param(
    [string]$YeniKok = $PSScriptRoot,
    [string]$BaslangicKlasoru = [Environment]::GetFolderPath('Startup'),
    [string[]]$KisayolKlasorleri = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('Programs'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'Stremio'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')),
    [switch]$SurecAramaYok
)
$ErrorActionPreference = 'Stop'
$yeni = [IO.Path]::GetFullPath($YeniKok).TrimEnd('\')
$yeniVeri = Join-Path $yeni 'data'

function Yaz($m) { Write-Host $m; try { New-Item -ItemType Directory -Force $yeniVeri | Out-Null; Add-Content -LiteralPath (Join-Path $yeniVeri 'baslatici.log') -Value ("{0} [zipten-gecis] {1}" -f (Get-Date), $m) -Encoding UTF8 } catch {} }

$sh = New-Object -ComObject WScript.Shell
$adaylar = New-Object System.Collections.Generic.List[string]
function Ekle($yol) { if ($yol) { try { $adaylar.Add([IO.Path]::GetFullPath($yol).TrimEnd('\')) } catch {} } }

# Başlangıç kısayolu: çalışma klasörü kurulum kökü
$lnk = Join-Path $BaslangicKlasoru 'Stremio Offline Servis.lnk'
if (Test-Path -LiteralPath $lnk) { try { Ekle $sh.CreateShortcut($lnk).WorkingDirectory } catch {} }
# "Stremio" kısayolları: argümandaki ...\baslat-stremio.vbs yolunun klasörü
foreach ($k in $KisayolKlasorleri) {
    if (-not $k -or -not (Test-Path -LiteralPath $k)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $k -Filter 'Stremio*.lnk' -File -ErrorAction SilentlyContinue) {
        try {
            $a = $sh.CreateShortcut($f.FullName).Arguments
            if ($a -match '"([^"]+)\\baslat-stremio\.vbs"') { Ekle $Matches[1] }
        } catch {}
    }
}
# Çalışan servis
if (-not $SurecAramaYok) {
    try {
        foreach ($p in Get-CimInstance Win32_Process -Filter "Name='node.exe'") {
            if ($p.CommandLine -match '"?([^"]*?)\\server\.mjs"?') { Ekle $Matches[1] }
        }
    } catch {}
}

$eski = $null
foreach ($a in $adaylar) {
    if ($a -ieq $yeni) { continue }
    if (Test-Path -LiteralPath (Join-Path $a 'server.mjs')) { $eski = $a; break }
}
if (-not $eski) { Write-Host 'Eski kurulum yok.'; exit 0 }
Yaz "eski kurulum bulundu: $eski"

# 1) Eski kurulumu kapat ve kısayollarını geri al (kurulum işareti yoksa zaten kaldırılmıştır)
$kaldir = Join-Path $eski 'kaldir.ps1'
if ((Test-Path -LiteralPath $kaldir) -and (Test-Path -LiteralPath (Join-Path $eski 'data\kurulum.json'))) {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $ps -NoProfile -ExecutionPolicy Bypass -File $kaldir -ServisiDurdur | Out-Null
    if ($LASTEXITCODE -ne 0) { Yaz "eski kaldir.ps1 hata verdi (çıkış $LASTEXITCODE); sürüyor" } else { Yaz 'eski kurulumun kısayolları geri alındı, servisi durdu' }
}

# 2) Verileri taşı: yeni kütüphane yoksa ya da boşsa (1.3.0'da algılanamayan kurulumlar güncellemede taşınır)
function KayitSayisi($dosya) {
    if (-not (Test-Path -LiteralPath $dosya)) { return -1 }
    try { $j = [IO.File]::ReadAllText($dosya).TrimStart([char]0xFEFF) | ConvertFrom-Json; return @($j.items).Count } catch { return -2 }
}
$eskiVeri = Join-Path $eski 'data'
$eskiSayi = KayitSayisi (Join-Path $eskiVeri 'library.json')
$yeniSayi = KayitSayisi (Join-Path $yeniVeri 'library.json')
if ($eskiSayi -gt 0 -and ($yeniSayi -eq -1 -or $yeniSayi -eq 0)) {
    New-Item -ItemType Directory -Force $yeniVeri | Out-Null
    foreach ($ad in 'library.json', 'library.v1.json') {
        $k = Join-Path $eskiVeri $ad
        if (Test-Path -LiteralPath $k) { Copy-Item -LiteralPath $k -Destination $yeniVeri -Force }
    }
    $k = Join-Path $eskiVeri 'ayarlar.json'
    if ((Test-Path -LiteralPath $k) -and -not (Test-Path -LiteralPath (Join-Path $yeniVeri 'ayarlar.json'))) { Copy-Item -LiteralPath $k -Destination $yeniVeri }
    foreach ($ad in 'torrents', 'meta', 'img') {
        $k = Join-Path $eskiVeri $ad
        if (-not (Test-Path -LiteralPath $k)) { continue }
        $h = Join-Path $yeniVeri $ad
        New-Item -ItemType Directory -Force $h | Out-Null
        Get-ChildItem -LiteralPath $k -Force | Copy-Item -Destination $h -Recurse -Force
    }
    $cfg = Join-Path $eski 'config.json'
    if ((Test-Path -LiteralPath $cfg) -and -not (Test-Path -LiteralPath (Join-Path $yeni 'config.json'))) { Copy-Item -LiteralPath $cfg -Destination $yeni }
    @{ eskiKok = $eski; an = (Get-Date).ToString('o'); kayit = $eskiSayi } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $yeniVeri 'gecis.json') -Encoding UTF8
    Yaz "veriler taşındı ($eskiSayi kayıt): $eskiVeri -> $yeniVeri"
} else { Yaz "veri taşınmadı (eski kayıt: $eskiSayi, yeni kayıt: $yeniSayi)" }
exit 0
