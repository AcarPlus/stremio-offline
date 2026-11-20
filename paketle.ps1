# Paylaşım paketi üretir: dist\StremioOffline\ (temiz klasör) + dist\StremioOffline.zip
# Pakete girer: servis kodu (server.mjs, lib, web, inject.js, package.json), başlatma/kurulum betikleri,
#   bin\rqbit.exe (yerelden), node\node.exe (bu makinede kurulu Node'dan kopya; taşınabilir),
#   paket\ altındaki KUR.cmd, KALDIR.cmd, OKU-BENI.txt (paket köküne).
# Girmez: data\, config.json (kişisel ayar), .git, node_modules, test, tools, docs, günlükler.
# İnternetten hiçbir şey indirmez. Sonda paket içeriğinde kişisel veri taraması yapar; bulursa hata verir.
param(
    [string]$Cikti = (Join-Path $PSScriptRoot 'dist'),
    [string]$NodeExe = ''
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ad = 'StremioOffline'
$hedef = Join-Path $Cikti $ad
$zip = Join-Path $Cikti ($ad + '.zip')

# Node: verilen yol > PATH'teki node. Sürüm package.json "engines" (>=22) ile uyumlu olmalı.
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $NodeExe -or -not (Test-Path $NodeExe)) { throw 'node.exe bulunamadı; -NodeExe ile yol ver.' }
$surum = (& $NodeExe --version).Trim()
if ([int]($surum.TrimStart('v').Split('.')[0]) -lt 22) { throw "Node sürümü eski: $surum (en az 22)" }
$rqbit = Join-Path $root 'bin\rqbit.exe'
if (-not (Test-Path $rqbit)) { throw "rqbit bulunamadı: $rqbit" }

if (Test-Path $hedef) { Remove-Item $hedef -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force $hedef | Out-Null

$dosyalar = 'server.mjs', 'inject.js', 'package.json', 'kur.ps1', 'kaldir.ps1', 'stremio-baslat.ps1', 'ortak.ps1', 'kisayol-onar.ps1',
    'baslat-servis.vbs', 'baslat-stremio.vbs', 'baslat.cmd'
foreach ($f in $dosyalar) { Copy-Item (Join-Path $root $f) $hedef }
foreach ($d in 'lib', 'web') {
    New-Item -ItemType Directory -Force (Join-Path $hedef $d) | Out-Null
    Get-ChildItem (Join-Path $root $d) -File | Where-Object { $_.Extension -notin '.log', '.bak', '.old' } |
        Copy-Item -Destination (Join-Path $hedef $d)
}
New-Item -ItemType Directory -Force (Join-Path $hedef 'bin'), (Join-Path $hedef 'node') | Out-Null
Copy-Item $rqbit (Join-Path $hedef 'bin')
Copy-Item $NodeExe (Join-Path $hedef 'node\node.exe')
# Paket kökü dosyaları; .cmd satır sonları CRLF olmalı.
foreach ($f in Get-ChildItem (Join-Path $root 'paket') -File) {
    $yol = Join-Path $hedef $f.Name
    if ($f.Extension -eq '.cmd') {
        $metin = [IO.File]::ReadAllText($f.FullName) -replace "`r?`n", "`r`n"
        [IO.File]::WriteAllText($yol, $metin, (New-Object Text.UTF8Encoding $false))
    } else { Copy-Item $f.FullName $yol }
}
# Bilgi: lisanslar (Node MIT, rqbit Apache-2.0) ve sürüm notu
"Node.js $surum (MIT lisansı, nodejs.org) - node\node.exe`r`nrqbit (Apache-2.0 lisansı, github.com/ikatkov/rqbit) - bin\rqbit.exe`r`n" |
    Set-Content (Join-Path $hedef 'node\SURUM.txt') -Encoding ASCII

# Kişisel veri taraması: kullanıcı adı, kullanıcı klasörü yolu, git e-postası.
$aranan = @("C:\Users\", 'C:/Users/', "\Users\$env:USERNAME", "/Users/$env:USERNAME", "\$env:USERNAME\", $env:USERNAME, $env:USERPROFILE)
$eposta = (git -C $root config user.email 2>$null)
if ($eposta) { $aranan += $eposta }
$bulgu = @()
foreach ($f in Get-ChildItem $hedef -Recurse -File) {
    if ($f.Extension -in '.exe') { $metin = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($f.FullName)) }
    else { $metin = [IO.File]::ReadAllText($f.FullName) }
    foreach ($a in $aranan) {
        # İkililerde derleme yolu gibi genel "C:\Users\" izleri olabilir; orada yalnız kullanıcı adı/e-posta aranır.
        # Çıplak kullanıcı adı da ikililerdeki base64 verisinde rastlantıyla geçebilir; ikililerde yol biçimi aranır.
        if ($f.Extension -eq '.exe' -and (($a -like '*Users*' -and $a -notlike "*$env:USERNAME*") -or $a -eq $env:USERNAME)) { continue }
        if ($a -and $metin.IndexOf($a, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $bulgu += "$($f.FullName.Substring($hedef.Length + 1)): '$a'" }
    }
}
if ($bulgu) { $bulgu | ForEach-Object { Write-Warning $_ }; throw 'Pakette kişisel veri bulundu; zip üretilmedi.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($hedef, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Paket hazır: $zip ($mb MB) - Node $surum"
