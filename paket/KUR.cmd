@echo off
rem Stremio Offline: tek adimda kurulum. Bu dosyaya cift tikla.
rem Stremio'nun masaustu / Baslat menusu kisayolunu ("Stremio") Indir dugmeleriyle acacak sekilde ayarlar
rem (yoksa olusturur), oturum acilisinda servisi baslatir,
rem sonra Stremio'yu Indir dugmeleriyle acar. Yonetici yetkisi istemez.
cd /d "%~dp0"
echo Stremio Offline kuruluyor...
rem Zip internetten geldiyse dosyalardaki "internetten indirildi" isaretini kaldir (yalniz bu klasorde).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Recurse -File | Unblock-File"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kur.ps1"
if errorlevel 1 (
  echo.
  echo Kurulum basarisiz oldu. Yukaridaki hata yazisini kurulumu gonderen kisiye ilet.
  pause
  exit /b 1
)
echo.
echo Stremio aciliyor...
wscript //B //Nologo "%~dp0baslat-stremio.vbs"
echo Tamam. Stremio'yu her zamanki gibi masaustundeki ya da Baslat menusundeki "Stremio" kisayolundan ac.
echo Bu pencere birkac saniye sonra kapanir.
timeout /t 8 >nul
