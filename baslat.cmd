@echo off
rem Offline Indir servisini baslatir. Pencereyi kapatinca servis durur.
cd /d "%~dp0"
title Stremio Offline Indir
if exist "node\node.exe" ("node\node.exe" server.mjs) else (node server.mjs)
pause
