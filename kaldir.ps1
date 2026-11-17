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

function Remove-Kisayol($klasor, $ad) {
    $yol = Join-Path $klasor ($ad + '.lnk')
    if (-not (Test-Path $yol)) { return }
    $arg = $sh.CreateShortcut($yol).Arguments
    if ($arg.Contains($root)) { Remove-Item $yol -Force; Write-Host "Silindi: $yol" }
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
    # Servis zorla kapatılınca motor süreçleri açık kalır: yalnızca çalıştırılabilir yolu bu klasörün
    # bin\rqbit.exe'si olanlar kapatılır (ada göre toplu kapatma yok).
    $rqbit = Join-Path $root 'bin\rqbit.exe'
    Get-CimInstance Win32_Process -Filter "Name='rqbit.exe'" |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $rqbit) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; Write-Host "Motor durduruldu (pid $($_.ProcessId))." }
}
Write-Host 'Kaldırıldı. (Çalışan servis, -ServisiDurdur verilmedikçe açık kalır.)'
