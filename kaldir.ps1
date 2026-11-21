# kur.ps1'in yaptıklarını geri alır (yalnızca bu klasördeki betiklere işaret eden kısayollar):
#   - "Stremio Offline Servis" (Başlangıç) silinir.
#   - Bizim başlatıcıya çevrilmiş Stremio kısayolları data\kisayol-yedek.json'daki asıllarına döner (Stremio programına);
#     bizim oluşturduğumuz (Stremio'ya ait olmayan) "Stremio.lnk"'ler silinir. Eski "Stremio Offline.lnk"'ler silinir.
#   - data\kurulum.json silinir (servis artık kısayolları onarmaz).
# Klasörler verilmezse kurulumda kaydedilenler (data\kurulum.json), o da yoksa kullanıcının klasörleri kullanılır.
# -ServisiDurdur: bu klasörün server.mjs'ini çalıştıran node sürecini de kapatır.
param(
    [string]$BaslangicKlasoru = '',
    [string]$MasaustuKlasoru = '',
    [string]$BaslatMenusuKlasoru = '',
    [string]$VeriKlasoru = '',
    [switch]$ServisiDurdur
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'ortak.ps1')
$veri = if ($VeriKlasoru) { [IO.Path]::GetFullPath($VeriKlasoru) } else { Get-VeriKlasoru $root }
$kurulumYolu = Join-Path $veri $script:KurulumDosyasi
$kurulum = Read-JsonDosya $kurulumYolu
$k = if ($kurulum) { $kurulum.klasorler } else { $null }
if (-not $BaslangicKlasoru) { $BaslangicKlasoru = if ($k -and $k.baslangic) { $k.baslangic } else { [Environment]::GetFolderPath('Startup') } }
if (-not $MasaustuKlasoru) { $MasaustuKlasoru = if ($k -and $k.masaustu) { $k.masaustu } else { [Environment]::GetFolderPath('Desktop') } }
if (-not $BaslatMenusuKlasoru) { $BaslatMenusuKlasoru = if ($k -and $k.baslatMenusu) { $k.baslatMenusu } else { [Environment]::GetFolderPath('Programs') } }

# Önce işaret silinir: çalışan servis artık kisayol-onar.ps1 ile kısayolları yeniden çevirmez.
if (Test-Path -LiteralPath $kurulumYolu) { Remove-Item -LiteralPath $kurulumYolu -Force }

if ($ServisiDurdur) {
    $bulunan = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains('server.mjs') }
    foreach ($p in $bulunan) {
        # Başka bir kurulumun paketle gelen node'u (<kök>\node\node.exe, kök bu klasör değil) ise o kurulumun servisidir:
        # dokunulmaz (ör. exe kurulumu eski zip/klasör kurulumunu kaldırırken yeni servis kapanmasın).
        $exe = [string]$p.ExecutablePath
        if ($exe -match '\\node\\node\.exe$' -and -not $exe.StartsWith((Join-Path $root 'node\'), [StringComparison]::OrdinalIgnoreCase)) { continue }
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

function Remove-Kisayol($yol) {
    if (-not (Test-Path -LiteralPath $yol)) { return }
    if (Test-Bizim (Get-KisayolBilgi $yol).Arguments $root) { Remove-Item -LiteralPath $yol -Force; Write-Host "Silindi: $yol" }
    else { Write-Host "Atlandı (bu klasöre ait değil): $yol" }
}

# Bizim başlatıcıya giden kısayolu Stremio'nun asıl haline döndürür. Asıl hedef artık yoksa (Stremio taşındı)
# güncel Stremio programına yönlendirilir.
function Restore-StremioKisayolu($yol, $asil) {
    $exe = Get-StremioExe
    $sh = New-Object -ComObject WScript.Shell
    $kl = $sh.CreateShortcut($yol)
    $hedef = if ($asil -and $asil.TargetPath -and (Test-Path -LiteralPath $asil.TargetPath)) { $asil.TargetPath } else { $exe }
    $kl.TargetPath = $hedef
    $kl.Arguments = if ($asil) { "$($asil.Arguments)" } else { '' }
    $kl.WorkingDirectory = if ($asil -and $hedef -eq $asil.TargetPath) { "$($asil.WorkingDirectory)" } else { Split-Path -Parent $hedef }
    $kl.Description = if ($asil) { "$($asil.Description)" } else { '' }
    $kl.IconLocation = if ($asil -and $hedef -eq $asil.TargetPath -and $asil.IconLocation) { "$($asil.IconLocation)" } else { "$hedef,0" }
    $kl.WindowStyle = if ($asil -and $asil.WindowStyle) { [int]$asil.WindowStyle } else { 1 }
    if ($asil -and $asil.Hotkey) { $kl.Hotkey = "$($asil.Hotkey)" }
    $kl.Save()
    try { if (Get-KisayolAumid $yol) { Set-KisayolAumid $yol -Kaldir } } catch {}   # bizim görev çubuğu kimliği kalmasın
    Write-Host "Stremio'nun asıl haline döndürüldü: $yol"
}

Remove-Kisayol (Join-Path $BaslangicKlasoru 'Stremio Offline Servis.lnk')

$yedek = Read-KisayolYedek $veri
$islenen = @()
foreach ($e in $yedek) {
    $yol = "$($e.yol)"; $islenen += $yol
    if (-not (Test-Path -LiteralPath $yol)) { continue }
    if (-not (Test-Bizim (Get-KisayolBilgi $yol).Arguments $root)) { Write-Host "Atlandı (artık bizim başlatıcıya gitmiyor): $yol"; continue }
    if ($e.bizimOlusturdu) { Remove-Item -LiteralPath $yol -Force; Write-Host "Silindi: $yol" }
    else { Restore-StremioKisayolu $yol $e.asil }
}
# Yedekte kaydı olmayan ama bizim başlatıcıya giden "Stremio.lnk" (yedek kaybolmuş): Stremio kuruluysa ona yönlendirilir, değilse silinir.
foreach ($aday in Get-StremioKisayolAdaylari $MasaustuKlasoru $BaslatMenusuKlasoru) {
    $yol = $aday.yol
    if (($islenen | Where-Object { $_ -ieq $yol }) -or -not (Test-Path -LiteralPath $yol)) { continue }
    if (-not (Test-Bizim (Get-KisayolBilgi $yol).Arguments $root)) { continue }
    if (Test-Path -LiteralPath (Get-StremioExe)) { Restore-StremioKisayolu $yol $null } else { Remove-Item -LiteralPath $yol -Force; Write-Host "Silindi: $yol" }
}
Remove-EskiKisayollar $root @($MasaustuKlasoru, $BaslatMenusuKlasoru) | ForEach-Object { Write-Host $_ }
$yedekYolu = Join-Path $veri $script:YedekDosyasi
if (Test-Path -LiteralPath $yedekYolu) { Remove-Item -LiteralPath $yedekYolu -Force }

Write-Host 'Kaldırıldı. (Çalışan servis, -ServisiDurdur verilmedikçe açık kalır.)'
