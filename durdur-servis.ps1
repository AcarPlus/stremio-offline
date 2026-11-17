# Offline Indir servisini temiz durdurur (ve istenirse yeniden baslatir). Yalnizca bu uygulamanin kendi sureci hedeflenir:
# servisin kapisini (vars. 11480, config.json) dinleyen, komut satirinda server.mjs olan ve /manifest.json'u bizim eklentiyi
# bildiren node sureci. Ada gore toplu kapatma yok; kisayollara dokunulmaz (silmek icin kaldir.ps1).
#   .durdur-servis.ps1              servisi durdurur (POST /api/kapat; servis motor sureclerini de kapatir)
#   .durdur-servis.ps1 -Yeniden     durdurur, ayni node ile gizli yeniden baslatir
#   -Port <n>   kapi (yoksa OFFLINE_PORT, sonra config.json, sonra 11480)   -BeklemeSn <n>   kapanis bekleme suresi (vars. 20)
# Servis ayrilan surede kapanmazsa yalnizca o surec (PID) zorla sonlandirilir; motorlar bir sonraki acilista pid dosyalarindan temizlenir.
param(
    [int]$Port = 0,
    [switch]$Yeniden,
    [string]$NodeYolu = '',
    [int]$BeklemeSn = 20
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if ($Port -le 0) {
    $Port = 11480
    try {
        $c = [IO.File]::ReadAllText((Join-Path $root 'config.json')).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if ($c.port) { $Port = [int]$c.port }
    } catch {}
    if ($env:OFFLINE_PORT) { $Port = [int]$env:OFFLINE_PORT }
}
$base = "http://127.0.0.1:$Port"

function Get-Manifest {
    try { return Invoke-RestMethod "$base/manifest.json" -TimeoutSec 3 } catch { return $null }
}

$node = if ($NodeYolu) { $NodeYolu } else { $null }
$dinleyen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($dinleyen) {
    $pidServis = [int]$dinleyen.OwningProcess
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pidServis"
    $m = Get-Manifest
    if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'server.mjs' -or -not $m -or "$($m.id)" -notmatch 'offline') {
        Write-Host "Kapi $Port bu uygulamanin servisi tarafindan tutulmuyor; hicbir sey kapatilmadi."
        exit 1
    }
    if (-not $node) { $node = $p.ExecutablePath }
    try { Invoke-WebRequest "$base/api/kapat" -Method Post -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}
    $t0 = Get-Date
    while ((Get-Process -Id $pidServis -ErrorAction SilentlyContinue) -and ((Get-Date) - $t0).TotalSeconds -lt $BeklemeSn) { Start-Sleep -Milliseconds 200 }
    if (Get-Process -Id $pidServis -ErrorAction SilentlyContinue) {
        Write-Host "Servis $BeklemeSn sn icinde kapanmadi; yalnizca o surec (pid $pidServis) zorla sonlandiriliyor."
        Stop-Process -Id $pidServis -Force -Confirm:$false
    } else { Write-Host "Servis durduruldu (pid $pidServis)." }
} else {
    Write-Host "Kapi $Port'ta servis calismiyor."
}

if ($Yeniden) {
    if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
    if (-not $node) { Write-Host 'Node.js bulunamadi; servis baslatilamadi.'; exit 1 }
    Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden
    $t0 = Get-Date
    while (-not (Get-Manifest) -and ((Get-Date) - $t0).TotalSeconds -lt 30) { Start-Sleep -Milliseconds 300 }
    if (Get-Manifest) { Write-Host 'Servis yeniden baslatildi.' } else { Write-Host 'Servis 30 sn icinde yanit vermedi (servis.log dosyasina bak).'; exit 1 }
}
