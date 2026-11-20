@echo off
rem Stremio Offline: tek adimda kurulum. Bu dosyaya cift tikla.
rem Uygulama dosyalari "uygulama" klasorundedir; kaldirmak icin uygulama\KALDIR.cmd.
rem Stremio'nun masaustu / Baslat menusu / gorev cubugu kisayolunu ("Stremio") Indir dugmeleriyle acacak sekilde ayarlar
rem (yoksa olusturur), oturum acilisinda servisi baslatir,
rem sonra Stremio'yu Indir dugmeleriyle acar. Yonetici yetkisi istemez.
if not exist "%~dp0uygulama\kur.ps1" (
  echo "uygulama" klasoru bulunamadi. Zip'in tamamini ayni yere ac ve KUR.cmd'yi yeniden calistir.
  pause
  exit /b 1
)
cd /d "%~dp0uygulama"
echo Stremio Offline kuruluyor...
rem Zip internetten geldiyse dosyalardaki "internetten indirildi" isaretini kaldir (yalniz bu klasorde).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Recurse -File | Unblock-File"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uygulama\kur.ps1"
if errorlevel 1 (
  echo.
  echo Kurulum basarisiz oldu. Yukaridaki hata yazisini github.com/AcarPlus/stremio-offline adresinde sorun olarak bildir.
  pause
  exit /b 1
)
echo.
echo Stremio aciliyor...
wscript //B //Nologo "%~dp0uygulama\baslat-stremio.vbs"
echo Tamam. Stremio'yu her zamanki gibi kendi simgesinden ac (masaustu, Baslat menusu ya da gorev cubugu).
echo Kaldirmak icin: uygulama klasorundeki KALDIR.cmd
echo Bu pencere birkac saniye sonra kapanir.
timeout /t 8 >nul
