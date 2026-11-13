@echo off
rem Offline Indir servisini baslatir. Pencereyi kapatinca servis durur.
cd /d "%~dp0"
title Stremio Offline Indir
node server.mjs
pause
