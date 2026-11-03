@echo off
cd /d "%~dp0"
title Bubble Break Server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and then run this again.
  pause
  exit /b
)
start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
