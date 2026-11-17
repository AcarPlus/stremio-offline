# kur.ps1'in oluşturduğu kısayolları siler (yalnızca bu klasördeki betiklere işaret edenleri).
# -ServisiDurdur: bu klasörün server.mjs'ini çalıştıran node sürecini de kapatır.
param(
    [string]$BaslangicKlasoru = [Environment]::GetFolderPath('Startup'),
    [string]$MasaustuKlasoru = [Environment]::GetFolderPath('Desktop'),
    [string]$BaslatMenusuKlasoru = [Environment]::GetFolderPath('Programs'),
    [switch]$ServisiDurdur
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$sh = New-Object -ComObject WScript.Shell

# E5: kisayolun argumanindaki tirnakli yollardan biri TAM OLARAK bu klasorun baslat-servis.vbs / baslat-stremio.vbs dosyasi mi?
# (onek eslesmesi yok: <klasor>-v2... baska kuruluma aittir; buyuk/kucuk harf farki onemsiz)
function Test-Bizim($arg) {
    $beklenen = @('baslat-servis.vbs', 'baslat-stremio.vbs') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $root $_)) }
    foreach ($m in [regex]::Matches($arg, '"([^"]+)"')) {
        try { $tam = [IO.Path]::GetFullPath($m.Groups[1].Value) } catch { continue }
        foreach ($b in $beklenen) { if ($tam.Equals($b, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
    }
    return $false
}

function Remove-Kisayol($klasor, $ad) {
    $yol = Join-Path $klasor ($ad + '.lnk')
    if (-not (Test-Path $yol)) { return }
    $arg = $sh.CreateShortcut($yol).Arguments
    if (Test-Bizim $arg) { Remove-Item $yol -Force; Write-Host "Silindi: $yol" }
    else { Write-Host "Atlandı (bu klasöre ait değil): $yol" }
}
Remove-Kisayol $BaslangicKlasoru 'Stremio Offline Servis'
Remove-Kisayol $MasaustuKlasoru 'Stremio Offline'
Remove-Kisayol $BaslatMenusuKlasoru 'Stremio Offline'

if ($ServisiDurdur) {
    $betik = Join-Path $root 'server.mjs'
    $bulunan = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains('server.mjs') }
    foreach ($p in $bulunan) {
        # Çalışma klasörü bilinemediğinden, yalnızca bu klasördeki servisin kapısını dinleyen süreç durdurulur.
        $kapi = 11480
        try { $c = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json; if ($c.port) { $kapi = $c.port } } catch {}
        $dinliyor = Get-NetTCPConnection -LocalPort $kapi -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $p.ProcessId }
        if ($dinliyor) { Stop-Process -Id $p.ProcessId; Write-Host "Servis durduruldu (pid $($p.ProcessId))." }
    }
}
Write-Host 'Kaldırıldı. (Çalışan servis, -ServisiDurdur verilmedikçe açık kalır.)'
