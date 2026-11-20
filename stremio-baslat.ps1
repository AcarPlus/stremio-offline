# Stremio'yu "İndir" düğmeleriyle açar (masaüstü/Başlat menüsündeki "Stremio" kısayolu bunu çağırır):
#  1) Offline İndir servisi çalışmıyorsa gizli pencerede başlatır,
#  2) Stremio'yu, servisin arayüze düğme ekleyebilmesi için gereken hata ayıklama kapısıyla açar
#     (kapı yalnızca bu başlatılan Stremio sürecine verilir; ortam değişkeni kalıcı yapılmaz).
# Stremio programı doğrudan açılırsa düğmeler görünmez; bu betikle aç.
# Stremio'nun yeri kaldırma kaydından (InstallLocation) bulunur (ortak.ps1 Get-StremioExe).
param([string]$NodeYolu = '')

$root = $PSScriptRoot
# Başlatıcı günlüğü (E4): data\baslatici.log; sınamada OFFLINE_DATA_DIR okunur.
$gunlukKlasoru = if ($env:OFFLINE_DATA_DIR) { $env:OFFLINE_DATA_DIR } else { Join-Path $root 'data' }
function Yaz-Gunluk($metin) {
    try {
        if (-not (Test-Path $gunlukKlasoru)) { New-Item -ItemType Directory -Path $gunlukKlasoru -Force | Out-Null }
        $f = Join-Path $gunlukKlasoru 'baslatici.log'
        if ((Test-Path $f) -and (Get-Item $f).Length -gt 1MB) { Remove-Item $f -Force }
        Add-Content -Path $f -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [stremio-baslat.ps1] ' + $metin) -Encoding UTF8
    } catch {}
}
# Beklenmeyen hata sessizce kaybolmasın
trap { Yaz-Gunluk ('HATA: ' + $_.Exception.Message + ' (' + $_.InvocationInfo.PositionMessage.Trim() + ')'); exit 1 }
. (Join-Path $root 'ortak.ps1')

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
# Varsayılan düğme Hayır (Button2) ve pencere her zaman önde (E2): yanlışlıkla Enter'a basınca Stremio kapanmasın.
function Show-Mesaj($metin, $dugmeler, $varsayilan = 'Button1') {
    Add-Type -AssemblyName System.Windows.Forms
    $sahip = New-Object System.Windows.Forms.Form
    $sahip.TopMost = $true
    try { return [System.Windows.Forms.MessageBox]::Show($sahip, $metin, 'Stremio Offline', $dugmeler, 'Question', $varsayilan) }
    finally { $sahip.Dispose() }
}

# 1) Servis (çalışıyorsa ikinci örnek zaten sessizce çıkar; yine de gereksiz başlatma yapma).
if (-not (Test-Url "http://127.0.0.1:$port/manifest.json")) {
    $yerelNode = Join-Path $root 'node\node.exe'
    $node = if ($NodeYolu -and (Test-Path $NodeYolu)) { $NodeYolu } elseif (Test-Path $yerelNode) { $yerelNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
    if ($node) {
        Start-Process $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden
        Yaz-Gunluk "servis baslatildi: $node"
    } else {
        Yaz-Gunluk 'Node.js bulunamadi; servis baslatilamadi.'
        [void](Show-Mesaj 'Node.js bulunamadı; indirme servisi başlatılamadı.' 'OK')
    }
}

# 2) Stremio (sınamada OFFLINE_STREMIO_EXE ile sahte bir program, OFFLINE_STREMIO_KAYIT ile sahte kaldırma kaydı verilebilir)
$stremio = Get-StremioExe
if (-not (Test-Path $stremio)) {
    Yaz-Gunluk "Stremio bulunamadi: $stremio"
    [void](Show-Mesaj "Stremio bulunamadı: $stremio" 'OK')
    exit 1
}
$procAdi = [IO.Path]::GetFileNameWithoutExtension($stremio)
$running = Get-Process $procAdi -ErrorAction SilentlyContinue
if ($running) {
    if (Test-Url "http://127.0.0.1:$debugPort/json/version") { exit 0 }   # zaten düğmeli açık
    # Düğmesiz açık. Kapatmak izlenen bir şeyi keser; önce sor.
    $cevap = Show-Mesaj ("Stremio düğmeler olmadan açık.`n`nDüğmelerin gelmesi için Stremio'yu kapatıp yeniden açmam gerekiyor." +
        "`nŞu an bir şey izliyorsan Hayır de.`n`nKapatıp yeniden açayım mı?") 'YesNo' 'Button2'
    if ($cevap -ne 'Yes') { Yaz-Gunluk 'Stremio dugmesiz acik; kullanici Hayir dedi, dokunulmadi.'; exit 0 }
    Yaz-Gunluk 'Stremio dugmesiz acik; kullanici onayiyla kapatilip yeniden aciliyor.'
    Get-Process $procAdi, stremio-runtime -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    Start-Sleep -Seconds 2
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort"
Start-Process $stremio
