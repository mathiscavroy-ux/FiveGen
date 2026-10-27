@echo off
chcp 65001 >nul
title FiveGen
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
  echo     Installe la version LTS sur https://nodejs.org puis relance start.bat.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installation des dependances...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [!] npm install a echoue.
    pause
    exit /b 1
  )
)

if not exist .env (
  echo Creation du fichier .env local...
  (
    echo ENGINE_API_KEY=
    echo ENGINE_MODEL=gemini-3.8-flash
    echo PORT=3210
    echo HOST=127.0.0.1
    echo ADMIN_EMAIL=
    echo FREE_CREDITS=10
  ) > .env
  echo [!] Ouvre .env et renseigne ENGINE_API_KEY et ADMIN_EMAIL, puis relance start.bat.
)

findstr /r /c:"^ENGINE_API_KEY=..*" .env >nul
if errorlevel 1 (
  echo.
  echo [!] ENGINE_API_KEY est vide dans .env : le site s'ouvre mais les generations echoueront.
  echo     Cle gratuite pour tes tests : https://aistudio.google.com/apikey
  echo     Pour tester sans cle : lance demo.bat
  echo.
)

start "" http://localhost:3210
node server\index.js
pause
