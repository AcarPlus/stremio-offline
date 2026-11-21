# Kurulum programı (exe) bunu kur.ps1'den önce çalıştırır: bu kullanıcıda eski bir zip kurulumu varsa yeni kuruluma taşır.
# Eski kurulum, Başlangıç klasöründeki "Stremio Offline Servis" kısayolunun çalışma klasöründen bulunur.
#   1) Eski klasörün kaldir.ps1'i çalışır: eski servis durur, Stremio kısayolları asıllarına döner (kur.ps1 yeniden çevirir).
#   2) Yeni kurulumda kütüphane yoksa eski veriler kopyalanır: library.json, ayarlar.json, torrents, meta, img ve config.json.
#      Kısayol yedeği, kurulum işareti, motor ve klip klasörleri, günlükler kopyalanmaz. Eski klasör silinmez.
# İndirilen filmler yerinde kalır (kütüphane mutlak yolları tutar). Yeniden çalıştırmak güvenlidir.
param(
    [string]$YeniKok = $PSScriptRoot,
    [string]$BaslangicKlasoru = [Environment]::GetFolderPath('Startup')
)
$ErrorActionPreference = 'Stop'
$yeni = [IO.Path]::GetFullPath($YeniKok).TrimEnd('\')
$yeniVeri = Join-Path $yeni 'data'

function Yaz($m) { Write-Host $m; try { New-Item -ItemType Directory -Force $yeniVeri | Out-Null; Add-Content -LiteralPath (Join-Path $yeniVeri 'baslatici.log') -Value ("{0} [zipten-gecis] {1}" -f (Get-Date), $m) -Encoding UTF8 } catch {} }

$lnk = Join-Path $BaslangicKlasoru 'Stremio Offline Servis.lnk'
if (-not (Test-Path -LiteralPath $lnk)) { Write-Host 'Eski kurulum yok.'; exit 0 }
$eski = ''
try { $eski = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).WorkingDirectory } catch {}
if (-not $eski) { Write-Host 'Eski kısayolun klasörü okunamadı.'; exit 0 }
$eski = [IO.Path]::GetFullPath($eski).TrimEnd('\')
if ($eski -ieq $yeni) { Write-Host 'Kısayol zaten bu kuruluma ait.'; exit 0 }
if (-not (Test-Path -LiteralPath (Join-Path $eski 'server.mjs'))) { Write-Host "Eski klasörde uygulama yok: $eski"; exit 0 }
Yaz "eski kurulum bulundu: $eski"

# 1) Eski kurulumu kapat ve kısayollarını geri al
$kaldir = Join-Path $eski 'kaldir.ps1'
if (Test-Path -LiteralPath $kaldir) {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $ps -NoProfile -ExecutionPolicy Bypass -File $kaldir -ServisiDurdur | Out-Null
    if ($LASTEXITCODE -ne 0) { Yaz "eski kaldir.ps1 hata verdi (çıkış $LASTEXITCODE); sürüyor" } else { Yaz 'eski kurulumun kısayolları geri alındı, servisi durdu' }
}

# 2) Verileri taşı (yeni kurulumda kütüphane yoksa)
$eskiVeri = Join-Path $eski 'data'
if ((Test-Path -LiteralPath (Join-Path $eskiVeri 'library.json')) -and -not (Test-Path -LiteralPath (Join-Path $yeniVeri 'library.json'))) {
    New-Item -ItemType Directory -Force $yeniVeri | Out-Null
    foreach ($ad in 'library.json', 'library.v1.json', 'ayarlar.json') {
        $k = Join-Path $eskiVeri $ad
        if (Test-Path -LiteralPath $k) { Copy-Item -LiteralPath $k -Destination $yeniVeri -Force }
    }
    foreach ($ad in 'torrents', 'meta', 'img') {
        $k = Join-Path $eskiVeri $ad
        if (Test-Path -LiteralPath $k) { Copy-Item -LiteralPath $k -Destination $yeniVeri -Recurse -Force }
    }
    $cfg = Join-Path $eski 'config.json'
    if ((Test-Path -LiteralPath $cfg) -and -not (Test-Path -LiteralPath (Join-Path $yeni 'config.json'))) { Copy-Item -LiteralPath $cfg -Destination $yeni }
    @{ eskiKok = $eski; an = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $yeniVeri 'gecis.json') -Encoding UTF8
    Yaz "veriler taşındı: $eskiVeri -> $yeniVeri"
} else { Yaz 'veri taşınmadı (eski kütüphane yok ya da yeni kurulumda zaten var)' }
exit 0
