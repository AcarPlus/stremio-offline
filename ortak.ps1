# kur.ps1, kaldir.ps1, kisayol-onar.ps1 ve stremio-baslat.ps1'in ortak yardımcıları (dot-source: . "$PSScriptRoot\ortak.ps1").
# Yalnız okuma ve kullanıcının kendi klasörlerindeki .lnk dosyaları; kayıt defterine yazmaz.
#
# Sınama değişkenleri:
#   OFFLINE_STREMIO_EXE    Stremio programının yolu (verilirse kaldırma kaydına hiç bakılmaz)
#   OFFLINE_STREMIO_KAYIT  kaldırma kaydı yerine okunacak JSON dosyası: {"InstallLocation": "...", "DisplayVersion": "..."}
#                          (dosya yoksa "Stremio kayıtlı değil" sayılır)
#   OFFLINE_DATA_DIR       veri klasörü (yoksa <kök>\data)

$script:StremioExeAdi = 'stremio-shell-ng.exe'
$script:KurulumDosyasi = 'kurulum.json'
$script:YedekDosyasi = 'kisayol-yedek.json'
$script:KisayolAlanlari = 'TargetPath', 'Arguments', 'WorkingDirectory', 'IconLocation', 'Description', 'WindowStyle', 'Hotkey'

function Get-VeriKlasoru($kok) {
    if ($env:OFFLINE_DATA_DIR) { return [IO.Path]::GetFullPath($env:OFFLINE_DATA_DIR) }
    return Join-Path $kok 'data'
}

# Başlatıcı günlüğü: <veri>\baslatici.log (1 MB'ı geçince sıfırlanır). Hata yutulur (günlük yazılamadı diye iş durmasın).
function Add-BaslaticiGunluk($veri, $kaynak, $metin) {
    try {
        if (-not (Test-Path -LiteralPath $veri)) { New-Item -ItemType Directory -Path $veri -Force | Out-Null }
        $f = Join-Path $veri 'baslatici.log'
        if ((Test-Path -LiteralPath $f) -and (Get-Item -LiteralPath $f).Length -gt 1MB) { Remove-Item -LiteralPath $f -Force }
        Add-Content -LiteralPath $f -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " [$kaynak] " + $metin) -Encoding UTF8
    } catch {}
}

function Read-JsonDosya($yol) {
    if (-not (Test-Path -LiteralPath $yol)) { return $null }
    try { return [IO.File]::ReadAllText($yol).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { return $null }
}

# BOM'suz UTF-8, önce geçici dosyaya yazılıp taşınır (yarım dosya kalmasın).
function Write-JsonDosya($yol, $nesne) {
    $klasor = Split-Path -Parent $yol
    if (-not (Test-Path -LiteralPath $klasor)) { New-Item -ItemType Directory -Path $klasor -Force | Out-Null }
    $gecici = "$yol.yeni"
    [IO.File]::WriteAllText($gecici, (ConvertTo-Json -InputObject $nesne -Depth 6), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $gecici -Destination $yol -Force
}

function Set-Ozellik($nesne, $ad, $deger) {
    if ($nesne.PSObject.Properties[$ad]) { $nesne.$ad = $deger } else { $nesne | Add-Member -NotePropertyName $ad -NotePropertyValue $deger }
}

# Stremio'nun kaldırma kaydı (kullanıcı başına kurulum HKCU; tüm kullanıcılar için kurulduysa HKLM). Yalnız okunur.
function Get-StremioKaydi {
    if ($env:OFFLINE_STREMIO_KAYIT) { return Read-JsonDosya $env:OFFLINE_STREMIO_KAYIT }
    foreach ($kok in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                     'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                     'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
        $k = Get-ChildItem -LiteralPath $kok -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
            Where-Object { "$($_.DisplayName)" -like 'Stremio*' -and $_.InstallLocation -and
                (Test-Path -LiteralPath ([IO.Path]::Combine($_.InstallLocation, $script:StremioExeAdi))) } |
            Select-Object -First 1
        if ($k) { return $k }
    }
    return $null
}

# Stremio programının yolu: OFFLINE_STREMIO_EXE > kaldırma kaydındaki InstallLocation > varsayılan kurulum yolu.
function Get-StremioExe {
    if ($env:OFFLINE_STREMIO_EXE) { return $env:OFFLINE_STREMIO_EXE }
    $k = Get-StremioKaydi
    if ($k -and $k.InstallLocation) {
        $y = [IO.Path]::Combine("$($k.InstallLocation)", $script:StremioExeAdi)   # Join-Path olmayan sürücüde hata verir
        if ($env:OFFLINE_STREMIO_KAYIT -or (Test-Path -LiteralPath $y)) { return $y }
    }
    return Join-Path $env:LOCALAPPDATA "Programs\Stremio\$script:StremioExeAdi"
}

# Bizim kısayolların simgesi: Stremio'nun kendi simgesi; Stremio yoksa genel bir simge.
function Get-KisayolSimgesi($exe) {
    if ($exe -and (Test-Path -LiteralPath $exe)) { return "$exe,0" }
    return "$env:SystemRoot\System32\shell32.dll,175"
}

# E5: kısayolun argümanındaki tırnaklı yollardan biri TAM OLARAK <kök>\baslat-servis.vbs / baslat-stremio.vbs mi?
# (önek eşleşmesi yok: <klasör>-v2... başka kuruluma aittir; büyük/küçük harf farkı önemsiz)
function Test-Bizim($arg, $kok = $root) {
    $beklenen = @('baslat-servis.vbs', 'baslat-stremio.vbs') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $kok $_)) }
    foreach ($m in [regex]::Matches("$arg", '"([^"]+)"')) {
        try { $tam = [IO.Path]::GetFullPath($m.Groups[1].Value) } catch { continue }
        foreach ($b in $beklenen) { if ($tam.Equals($b, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
    }
    return $false
}

# Kısayol doğrudan bir Stremio programına mı gidiyor (Stremio'nun kendi kısayolu)? stremio-shell-ng.exe (5), stremio.exe (4)
function Test-StremioHedefi($hedef) {
    if (-not $hedef) { return $false }
    $ad = [IO.Path]::GetFileName("$hedef")
    return ($ad -like 'stremio*.exe')
}

function Get-KisayolBilgi($yol) {
    $k = (New-Object -ComObject WScript.Shell).CreateShortcut($yol)
    $h = [ordered]@{}
    foreach ($a in $script:KisayolAlanlari) { $h[$a] = $k.$a }
    return $h
}

function Get-BizimArgumanlar($kok, $vbs, $node) { return "//B //Nologo `"$(Join-Path $kok $vbs)`" `"$node`"" }

# Bizim başlatıcıya giden kısayolu yazar. Dosya varsa yerinde düzenlenir (Stremio'nun koyduğu diğer bilgiler korunur).
function Set-BizimKisayol($yol, $kok, $vbs, $node, $aciklama, $simge) {
    $k = (New-Object -ComObject WScript.Shell).CreateShortcut($yol)
    $k.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $k.Arguments = Get-BizimArgumanlar $kok $vbs $node
    $k.WorkingDirectory = $kok
    $k.WindowStyle = 7
    $k.Description = $aciklama
    if ($simge) { $k.IconLocation = $simge }
    $k.Save()
    # "Stremio" kısayolu: Stremio penceresiyle aynı görev çubuğu kimliği (tek düğme; sabitleme bizim başlatıcıyı tutar)
    if ($vbs -eq 'baslat-stremio.vbs' -and $env:OFFLINE_AUMID -ne '0') {
        try { Set-KisayolAumid $yol } catch { Write-Warning "gorev cubugu kimligi yazilamadi: $yol ($($_.Exception.Message))" }
    }
}

# Bizim kısayol beklenenden farklı mı (başka node yolu, eski Stremio simgesi...)? $simge $null ise simgeye bakılmaz.
function Test-BizimGuncel($yol, $kok, $vbs, $node, $simge) {
    $b = Get-KisayolBilgi $yol
    if ($b.TargetPath -ine (Join-Path $env:SystemRoot 'System32\wscript.exe')) { return $false }
    if ($b.Arguments -ine (Get-BizimArgumanlar $kok $vbs $node)) { return $false }
    if ($b.WorkingDirectory -ine $kok) { return $false }
    if ($simge -and $b.IconLocation -ine $simge) { return $false }
    if ($vbs -eq 'baslat-stremio.vbs' -and $env:OFFLINE_AUMID -ne '0') {
        try { if ((Get-KisayolAumid $yol) -ne $script:StremioAumid) { return $false } } catch {}
    }
    return $true
}

# ---- Yedek: değiştirilen Stremio kısayollarının asılları (<veri>\kisayol-yedek.json) ----
# { surum: 1, kisayollar: [ { yol, bizimOlusturdu, zaman, asil: { TargetPath, Arguments, ... } } ] }
function Read-KisayolYedek($veri) {
    $y = Read-JsonDosya (Join-Path $veri $script:YedekDosyasi)
    if (-not $y) { return , @() }
    return , @($y.kisayollar | Where-Object { $_ -and $_.yol })
}

function Write-KisayolYedek($veri, $liste) {
    Write-JsonDosya (Join-Path $veri $script:YedekDosyasi) ([ordered]@{ surum = 1; kisayollar = @($liste) })
}

function Get-YedekKaydi($liste, $yol) {
    foreach ($e in $liste) { if ("$($e.yol)" -ieq $yol) { return $e } }
    return $null
}

function Set-YedekKaydi($liste, $yol, $bizimOlusturdu, $asil) {
    $yeni = @($liste | Where-Object { $_ -and "$($_.yol)" -ine $yol })
    $yeni += [pscustomobject][ordered]@{ yol = $yol; bizimOlusturdu = [bool]$bizimOlusturdu; zaman = (Get-Date).ToString('o'); asil = $asil }
    return , $yeni
}

# Stremio kısayolu adayları: masaüstü\Stremio.lnk, Başlat menüsü\Stremio.lnk ve (varsa) Başlat menüsü\Stremio\Stremio.lnk.
# Görev çubuğuna sabitlenmiş kısayollara (User Pinned\TaskBar) bilerek dokunulmaz.
# ---- Görev çubuğu kimliği (AppUserModelID) ----
# Stremio penceresine ve bizim "Stremio" kısayollarımıza aynı kimlik yazılır: görev çubuğunda tek düğme olur ve
# açık pencere "Görev çubuğuna sabitle" ile sabitlenince Windows doğrudan stremio-shell-ng.exe'yi değil, pencerenin
# RelaunchCommand'ını (bizim başlatıcı) sabitler; sabitten açınca düğmeler gelir.
$script:StremioAumid = 'StremioOffline.Stremio'
function Add-AumidTipi {
    if ('StremioOfflineAumid' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class StremioOfflineAumid {
    [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PK { public Guid f; public uint p; }
    [StructLayout(LayoutKind.Explicit)] public struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(8)] public long pad; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPS {
        [PreserveSig] int GetCount(out uint c);
        [PreserveSig] int GetAt(uint i, out PK k);
        [PreserveSig] int GetValue(ref PK k, out PV v);
        [PreserveSig] int SetValue(ref PK k, ref PV v);
        [PreserveSig] int Commit();
    }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPS ps);
    static PK Anahtar(uint pid) { return new PK { f = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), p = pid }; }
    static IPS Depo(IntPtr h) {
        Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPS ps;
        int hr = SHGetPropertyStoreForWindow(h, ref iid, out ps);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        return ps;
    }
    // pid: 5 ID, 2 RelaunchCommand, 3 RelaunchIconResource, 4 RelaunchDisplayNameResource
    static void Yaz(IPS ps, uint pid, string deger) {
        var k = Anahtar(pid);
        var v = new PV(); // deger null: VT_EMPTY (özellik silinir)
        if (deger != null) { v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(deger); }
        try { int hr = ps.SetValue(ref k, ref v); if (hr != 0) Marshal.ThrowExceptionForHR(hr); } finally { if (v.p != IntPtr.Zero) Marshal.FreeCoTaskMem(v.p); }
    }
    static string Oku(IPS ps, uint pid) {
        var k = Anahtar(pid); PV v;
        if (ps.GetValue(ref k, out v) != 0 || v.vt != 31) return null;
        return Marshal.PtrToStringUni(v.p);
    }
    public static void Pencere(IntPtr hwnd, string id, string komut, string simge, string ad) {
        var ps = Depo(hwnd);
        // Relaunch* alanları kimlikten ÖNCE yazılır (kimlik yazılınca görev çubuğu hepsini birlikte okur)
        Yaz(ps, 2, komut); Yaz(ps, 3, simge); Yaz(ps, 4, ad); Yaz(ps, 5, id);
        ps.Commit();
    }
    // Tanı/sınama için: pencerenin kimliği (yoksa null)
    public static string PencereOku(IntPtr hwnd) {
        Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPS ps;
        if (SHGetPropertyStoreForWindow(hwnd, ref iid, out ps) != 0) return null;
        var k = new PK { f = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), p = 5 };
        uint c; ps.GetCount(out c);
        PV r; int g = ps.GetValue(ref k, out r);
        return g == 0 && r.vt == 31 ? Marshal.PtrToStringUni(r.p) : null;
    }
    public static void Kisayol(string yol, string id) {
        var link = new CShellLink();
        ((IPersistFile)link).Load(yol, 2);
        var ps = (IPS)link;
        Yaz(ps, 5, id);
        int hr = ps.Commit(); if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        ((IPersistFile)link).Save(yol, true);
    }
}
'@
}
# $kaldir: kimliği siler (kaldir.ps1 Stremio'nun asıl kısayolunu geri getirirken)
function Set-KisayolAumid($yol, [switch]$Kaldir) { Add-AumidTipi; [StremioOfflineAumid]::Kisayol([IO.Path]::GetFullPath($yol), $(if ($Kaldir) { $null } else { $script:StremioAumid })) }
# Kısayolun kimliğini Gezgin'in özellik sisteminden okur (bağımsız okuyucu; sınama ve onarım için)
function Get-KisayolAumid($yol) {
    $tam = [IO.Path]::GetFullPath($yol)
    $o = (New-Object -ComObject Shell.Application).NameSpace([IO.Path]::GetDirectoryName($tam)).ParseName([IO.Path]::GetFileName($tam))
    if (-not $o) { return $null }
    return $o.ExtendedProperty('System.AppUserModel.ID')
}
# Açık Stremio penceresine kimlik + "sabitlenince bizim başlatıcı açılsın" komutu yazar.
function Set-StremioPencereAumid($hwnd, $kok, $node, $exe) {
    Add-AumidTipi
    $komut = "`"$(Join-Path $env:SystemRoot 'System32\wscript.exe')`" $(Get-BizimArgumanlar $kok 'baslat-stremio.vbs' $node)"
    [StremioOfflineAumid]::Pencere([IntPtr]$hwnd, $script:StremioAumid, $komut, (Get-KisayolSimgesi $exe), 'Stremio')
}

function Get-StremioKisayolAdaylari($masaustu, $menu, $gorev = $null) {
    $a = @()
    # Görev çubuğuna sabitlenmiş Stremio kısayolları (User Pinned\TaskBar; adı "Stremio" ile başlayan)
    if ($gorev -and (Test-Path -LiteralPath $gorev)) {
        foreach ($f in Get-ChildItem -LiteralPath $gorev -Filter 'Stremio*.lnk' -File -ErrorAction SilentlyContinue) { $a += @{ yer = 'gorev'; yol = $f.FullName } }
    }
    if ($masaustu) { $a += @{ yer = 'masaustu'; yol = [IO.Path]::Combine($masaustu, 'Stremio.lnk') } }
    if ($menu) {
        $a += @{ yer = 'menu'; yol = [IO.Path]::Combine($menu, 'Stremio.lnk') }
        $a += @{ yer = 'menu'; yol = [IO.Path]::Combine($menu, 'Stremio', 'Stremio.lnk') }
    }
    return $a
}

$script:StremioAciklama = "Stremio'yu Offline İndir düğmeleriyle aç"

# Stremio kısayollarını bizim başlatıcıya bağlar. Dönüş: @{ degisiklikler = @(...); atlananlar = @(...); yedek = <liste> }
#  - Stremio'nun kendi kısayolu (hedef stremio*.exe): asıl hali yedeğe yazılır, yerinde bizim başlatıcıya çevrilir.
#  - Bizim kısayol: beklenenden farklıysa (node yolu, Stremio simgesi) güncellenir.
#  - Başka bir şeye giden "Stremio.lnk": dokunulmaz.
#  - -Olustur: masaüstünde / Başlat menüsünde Stremio kısayolu yoksa "Stremio.lnk" oluşturulur (yedekte bizimOlusturdu).
#  - -GorevCubugu: sabitlenmiş Stremio kısayolları da çevrilir (görev çubuğu kimliği sayesinde tek düğme kalır); oluşturulmaz.
function Invoke-StremioKisayolDuzeni($kok, $node, $exe, $masaustu, $menu, $veri, [switch]$Olustur, [string]$GorevCubugu = '') {
    $simge = if ($exe -and (Test-Path -LiteralPath $exe)) { "$exe,0" } else { $null }
    $yedek = Read-KisayolYedek $veri
    $degisiklikler = @()
    $atlananlar = @()
    $bulunan = @{ masaustu = $false; menu = $false; gorev = $false }
    foreach ($aday in Get-StremioKisayolAdaylari $masaustu $menu $GorevCubugu) {
        $yol = $aday.yol; $yer = $aday.yer
        if (-not (Test-Path -LiteralPath $yol)) { continue }
        $b = Get-KisayolBilgi $yol
        # Önce hedefe bakılır: doğrudan Stremio programına giden kısayol (bizim argümanlar kalmış olsa bile) Stremio'nundur.
        if (Test-StremioHedefi $b.TargetPath) {
            $bulunan[$yer] = $true
            if (Test-Bizim $b.Arguments $kok) { $b.Arguments = '' }
            $asil = [pscustomobject]$b
            $yedek = Set-YedekKaydi $yedek $yol $false $asil
            Write-KisayolYedek $veri $yedek   # önce yedek, sonra değişiklik
            Set-BizimKisayol $yol $kok 'baslat-stremio.vbs' $node $script:StremioAciklama ($(if ($simge) { $simge } else { Get-KisayolSimgesi $b.TargetPath }))
            $degisiklikler += "Stremio kisayolu baslaticiya yonlendirildi: $yol (asil hedef: $($b.TargetPath))"
        } elseif (Test-Bizim $b.Arguments $kok) {
            $bulunan[$yer] = $true
            if (-not (Test-BizimGuncel $yol $kok 'baslat-stremio.vbs' $node $simge)) {
                Set-BizimKisayol $yol $kok 'baslat-stremio.vbs' $node $script:StremioAciklama $simge
                $degisiklikler += "guncellendi: $yol"
            }
        } else {
            $bulunan[$yer] = $true   # başkasının "Stremio.lnk"'inin üzerine yazılmaz
            $atlananlar += "atlandi (Stremio'ya ya da bu klasore ait degil): $yol"
        }
    }
    if ($Olustur) {
        foreach ($y in @(@{ yer = 'masaustu'; klasor = $masaustu }, @{ yer = 'menu'; klasor = $menu })) {
            if ($bulunan[$y.yer] -or -not $y.klasor) { continue }
            if (-not (Test-Path -LiteralPath $y.klasor)) { throw "Klasör yok: $($y.klasor)" }
            $yol = [IO.Path]::Combine($y.klasor, 'Stremio.lnk')
            $yedek = Set-YedekKaydi $yedek $yol $true $null
            Write-KisayolYedek $veri $yedek
            Set-BizimKisayol $yol $kok 'baslat-stremio.vbs' $node $script:StremioAciklama (Get-KisayolSimgesi $exe)
            $degisiklikler += "olusturuldu: $yol"
        }
    }
    return @{ degisiklikler = $degisiklikler; atlananlar = $atlananlar; yedek = $yedek }
}

# Eski sürümün "Stremio Offline.lnk" kısayollarını siler (yalnız bu klasöre ait olanları).
function Remove-EskiKisayollar($kok, $klasorler) {
    $sonuc = @()
    foreach ($klasor in $klasorler) {
        if (-not $klasor) { continue }
        $yol = [IO.Path]::Combine($klasor, 'Stremio Offline.lnk')
        if (-not (Test-Path -LiteralPath $yol)) { continue }
        if (Test-Bizim (Get-KisayolBilgi $yol).Arguments $kok) { Remove-Item -LiteralPath $yol -Force; $sonuc += "eski kisayol silindi: $yol" }
        else { $sonuc += "atlandi (bu klasore ait degil): $yol" }
    }
    return $sonuc
}

# Paketle gelen node\node.exe > PATH'teki node.
function Find-Node($kok) {
    $yerel = Join-Path $kok 'node\node.exe'
    if (Test-Path -LiteralPath $yerel) { return $yerel }
    return (Get-Command node -ErrorAction SilentlyContinue).Source
}
