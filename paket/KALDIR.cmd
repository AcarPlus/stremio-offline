@echo off
rem Stremio Offline'i kaldirir: kisayollari siler, calisan servisi ve indirme motorlarini kapatir.
rem Indirdigin filmler (Videolar\Stremio-Offline) silinmez.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kaldir.ps1" -ServisiDurdur
echo.
echo Kaldirildi. Istersen simdi bu klasoru silebilirsin.
pause
