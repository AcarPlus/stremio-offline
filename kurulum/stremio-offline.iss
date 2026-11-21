; Stremio Offline kurulum programı (Inno Setup 6). Derleme: paketle.ps1 (önce dist\StremioOffline\ üretir, sonra
;   ISCC /DAppVersion=<sürüm> kurulum\stremio-offline.iss). Çıktı: dist\StremioOffline-Kurulum.exe
; Yönetici yetkisi istemez: kullanıcının kendi klasörüne kurulur (%LOCALAPPDATA%\Programs\StremioOffline).
; Kurulum sonrası: zipten-gecis.ps1 (eski zip kurulumu varsa taşır) + kur.ps1 (kısayollar, oturum açılışında servis).
; Uygulama içi güncelleme bu programı /SILENT /SUPPRESSMSGBOXES /NORESTART /UPDATE ile çalıştırır: sonunda servis yeniden başlar.
; Kaldırma: kaldir.ps1 -ServisiDurdur (kısayollar asıllarına döner); indirilen filmler silinmez.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Stremio Offline"
#define Kaynak "..\dist\StremioOffline"

#if !FileExists(SourcePath + Kaynak + "\server.mjs")
  #error dist\StremioOffline yok: önce paketle.ps1 çalıştır
#endif

[Setup]
; Sabit kimlik: güncelleme ve kaldırma bununla tanınır, DEĞİŞTİRME
AppId={{6C2B1E7A-4F3D-4B8E-9A51-3D7E2C9F0B14}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=AcarPlus
AppPublisherURL=https://github.com/AcarPlus/stremio-offline
AppSupportURL=https://github.com/AcarPlus/stremio-offline/issues
AppUpdatesURL=https://github.com/AcarPlus/stremio-offline/releases
VersionInfoVersion={#AppVersion}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DefaultDirName={localappdata}\Programs\StremioOffline
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
UninstallDisplayName={#AppName}
LicenseFile=..\LICENSE
OutputDir=..\dist
OutputBaseFilename=StremioOffline-Kurulum
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no

[Languages]
Name: "tr"; MessagesFile: "compiler:Languages\Turkish.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
tr.AcStremio=Stremio'yu İndir düğmeleriyle aç
en.AcStremio=Open Stremio with the Download buttons
tr.KurHata=Kısayollar ayarlanamadı (kur.ps1 çıkış kodu %1). Ayrıntı: %2
en.KurHata=Shortcuts could not be set up (kur.ps1 exit code %1). Details: %2

[InstallDelete]
; eski sürümün kod dosyaları (data\ ve config.json'a dokunulmaz)
Type: filesandordirs; Name: "{app}\lib"
Type: filesandordirs; Name: "{app}\web"

[Files]
Source: "{#Kaynak}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
; ilk kurulum: Stremio'yu düğmeli aç (servisi de başlatır)
Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{app}\baslat-stremio.vbs"""; Description: "{cm:AcStremio}"; Flags: nowait postinstall skipifsilent
; uygulama içi güncellemede (/UPDATE) servis CurStepChanged(ssPostInstall) içinde, geçiş ve kısayollardan SONRA başlar:
; [Run] girdileri ssPostInstall'dan önce çalışır, burada başlatılırsa eski kurulumun kaldir.ps1'i yeni servisi kapatabilir.

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\kaldir.ps1"" -ServisiDurdur"; Flags: runhidden waituntilterminated; RunOnceId: "StremioOfflineKaldir"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function GuncellemeMi(): Boolean;
var
  i: Integer;
begin
  Result := False;
  for i := 1 to ParamCount do
    if CompareText(ParamStr(i), '/UPDATE') = 0 then
      Result := True;
end;

function PowerShell(const Betik, Ek: String): Integer;
var
  rc: Integer;
begin
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + Betik + '"' + Ek, '', SW_HIDE, ewWaitUntilTerminated, rc) then
    rc := -1;
  Result := rc;
end;

// Çalışan servis (bu kurulumunki ya da eski bir zip kurulumunun) dosyalar değişmeden önce temizce durur.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  durdur: String;
begin
  durdur := ExpandConstant('{app}\durdur-servis.ps1');
  if FileExists(durdur) then
    PowerShell(durdur, '');
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  rc: Integer;
begin
  if CurStep <> ssPostInstall then
    Exit;
  PowerShell(ExpandConstant('{app}\zipten-gecis.ps1'), '');
  rc := PowerShell(ExpandConstant('{app}\kur.ps1'), '');
  if rc <> 0 then
    SuppressibleMsgBox(FmtMessage(CustomMessage('KurHata'), [IntToStr(rc), ExpandConstant('{app}\data\baslatici.log')]), mbError, MB_OK, IDOK);
  // Uygulama içi güncelleme: servisi şimdi başlat (Stremio'daki düğmeler servis açılınca kendiliğinden yenilenir)
  if GuncellemeMi() then
    Exec(ExpandConstant('{sys}\wscript.exe'), '//B //Nologo "' + ExpandConstant('{app}\baslat-servis.vbs') + '" "' +
      ExpandConstant('{app}\node\node.exe') + '"', '', SW_HIDE, ewNoWait, rc);
end;

// Kaldırmadan önce servis durur (dosyalar kilitli kalmasın)
function InitializeUninstall(): Boolean;
var
  durdur: String;
begin
  durdur := ExpandConstant('{app}\durdur-servis.ps1');
  if FileExists(durdur) then
    PowerShell(durdur, '');
  Result := True;
end;
