# Stremio'yu "İndir" düğmeleriyle açar (masaüstü/Başlat menüsündeki "Stremio Offline" kısayolu bunu çağırır):
#  1) Offline İndir servisi çalışmıyorsa gizli pencerede başlatır,
#  2) Stremio'yu, servisin arayüze düğme ekleyebilmesi için gereken hata ayıklama kapısıyla açar
#     (kapı yalnızca bu başlatılan Stremio sürecine verilir; ortam değişkeni kalıcı yapılmaz).
# Stremio'yu eski kısayolundan açarsan düğmeler görünmez; bu betikle aç.
param([string]$NodeYolu = '')

$root = $PSScriptRoot
$port = 11480
$debugPort = 11481
try {
    $cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    if ($cfg.port) { $port = $cfg.port }
    if ($cfg.debugPort) { $debugPort = $cfg.debugPort }
} catch {}
# Sınama için ortam değişkenleri (servisle aynı adlar).
if ($env:OFFLINE_PORT) { $port = [int]$env:OFFLINE_PORT }

function Test-Url($url) {
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
function Show-Mesaj($metin, $dugmeler) {
    Add-Type -AssemblyName System.Windows.Forms
    return [System.Windows.Forms.MessageBox]::Show($metin, 'Stremio Offline', $dugmeler, 'Question')
}

# 1) Servis (çalışıyorsa ikinci örnek zaten sessizce çıkar; yine de gereksiz başlatma yapma).
if (-not (Test-Url "http://127.0.0.1:$port/manifest.json")) {
    $node = if ($NodeYolu) { $NodeYolu } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
    if ($node) {
        Start-Process $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden
    } else {
        [void](Show-Mesaj 'Node.js bulunamadı; indirme servisi başlatılamadı.' 'OK')
    }
}

# 2) Stremio (sınamada OFFLINE_STREMIO_EXE ile sahte bir program verilebilir)
$stremio = if ($env:OFFLINE_STREMIO_EXE) { $env:OFFLINE_STREMIO_EXE } else { Join-Path $env:LOCALAPPDATA 'Programs\Stremio\stremio-shell-ng.exe' }
if (-not (Test-Path $stremio)) {
    [void](Show-Mesaj "Stremio bulunamadı: $stremio" 'OK')
    exit 1
}
$procAdi = [IO.Path]::GetFileNameWithoutExtension($stremio)
$running = Get-Process $procAdi -ErrorAction SilentlyContinue
if ($running) {
    if (Test-Url "http://127.0.0.1:$debugPort/json/version") { exit 0 }   # zaten düğmeli açık
    # Düğmesiz açık. Kapatmak izlenen bir şeyi keser; önce sor.
    $cevap = Show-Mesaj ("Stremio düğmeler olmadan açık.`n`nDüğmelerin gelmesi için Stremio'yu kapatıp yeniden açmam gerekiyor." +
        "`nŞu an bir şey izliyorsan Hayır de.`n`nKapatıp yeniden açayım mı?") 'YesNo'
    if ($cevap -ne 'Yes') { exit 0 }
    Get-Process $procAdi, stremio-runtime -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    Start-Sleep -Seconds 2
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort"
Start-Process $stremio
