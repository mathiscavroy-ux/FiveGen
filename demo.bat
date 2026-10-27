@echo off
chcp 65001 >nul
title FiveGen (demo)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js n'est pas installe. Telecharge-le sur https://nodejs.org (version 22 ou plus^).
  pause
  exit /b 1
)

rem FiveGen needs the built-in SQLite module (Node.js 22.13+).
node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  for /f %%v in ('node -v') do echo [!] Node.js %%v est trop ancien : FiveGen demande Node.js 22 ou plus.
  echo     Installe la version LTS sur https://nodejs.org puis relance demo.bat.
  pause
  exit /b 1
)

if not exist node_modules call npm install --omit=dev

start "" http://localhost:3211
node server\demo.js
pause
