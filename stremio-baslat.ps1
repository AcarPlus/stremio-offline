# Stremio'yu "Cihaza indir" menü düğmeleriyle açar:
#  1) Offline İndir servisi çalışmıyorsa gizli pencerede başlatır,
#  2) Stremio'yu, servisin arayüze düğme ekleyebilmesi için gereken ayarla açar.
# Stremio'yu normal kısayolundan açarsan düğmeler görünmez; bu betikle aç.

$root = $PSScriptRoot
$port = 11480
$debugPort = 11481
try {
    $cfg = Get-Content (Join-Path $root 'config.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($cfg.port) { $port = $cfg.port }
    if ($cfg.debugPort) { $debugPort = $cfg.debugPort }
} catch {}

function Test-Url($url) {
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (-not (Test-Url "http://127.0.0.1:$port/manifest.json")) {
    Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden
}

$stremio = Join-Path $env:LOCALAPPDATA 'Programs\Stremio\stremio-shell-ng.exe'
$running = Get-Process stremio-shell-ng -ErrorAction SilentlyContinue
if ($running -and -not (Test-Url "http://127.0.0.1:$debugPort/json/version")) {
    # Stremio düğme ayarı olmadan açılmış: kapatıp doğru ayarla yeniden aç.
    Get-Process stremio-shell-ng, stremio-runtime -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    Start-Sleep -Seconds 2
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort"
Start-Process $stremio
