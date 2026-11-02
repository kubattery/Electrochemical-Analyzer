@echo off
rem ---------------------------------------------------------------------------
rem  ESMPL Analyzer - one-file setup for Codex.
rem
rem  Does everything in order, skipping whatever is already done:
rem    1. check Node.js
rem    2. fetch the analyzer files if they are not next to this script
rem    3. install the Codex CLI
rem    4. sign in with your own ChatGPT account (device code)
rem    5. start the local relay
rem
rem  KEEP THIS FILE PURE ASCII, and never put a runnable command where only
rem  text is meant. "chcp 65001" plus a UTF-8 batch file makes cmd.exe misparse
rem  later lines: the "echo" prefix can be dropped and the rest executed. That
rem  actually happened once with a global-install line. Every message line here
rem  starts with "-" so it cannot run even if the prefix is lost.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo - ESMPL Analyzer - Codex setup
echo - ----------------------------------------
echo.

rem --- 1. Node.js ------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo - Node.js is required but was not found.
  echo - Opening the download page. Install the LTS version,
  echo - then close this window and run this file again.
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODEV=%%v
echo - Node.js !NODEV!  OK

rem --- 2. analyzer files -----------------------------------------------------
set ROOT=%~dp0..\..
if not exist "%ROOT%\server\local\server.js" (
  echo - Analyzer files not found next to this script. Downloading...
  set ROOT=%CD%\Electrochemical-Analyzer-main
  if not exist "!ROOT!\server\local\server.js" (
    curl -L -o "%CD%\analyzer.zip" "https://github.com/kubattery/Electrochemical-Analyzer/archive/refs/heads/main.zip"
    if errorlevel 1 goto nodownload
    tar -xf "%CD%\analyzer.zip" -C "%CD%"
    if errorlevel 1 goto nodownload
    del "%CD%\analyzer.zip" >nul 2>nul
  )
  if not exist "!ROOT!\server\local\server.js" goto nodownload
  echo - Downloaded.
) else (
  echo - Analyzer files  OK
)

rem --- 3. Codex CLI ----------------------------------------------------------
where codex >nul 2>nul
if errorlevel 1 (
  echo - Installing the Codex CLI. This takes a minute...
  call npm install -g @openai/codex
  where codex >nul 2>nul
  if errorlevel 1 (
    echo.
    echo - The Codex CLI still is not on PATH.
    echo - Close this window, open a new one, and run this file again.
    echo - A fresh window picks up newly installed commands.
    echo.
    pause
    exit /b 1
  )
)
echo - Codex CLI  OK

rem --- 4. sign in ------------------------------------------------------------
codex login status 2>nul | findstr /C:"Not logged in" >nul
if not errorlevel 1 (
  echo.
  echo - Signing in with your own ChatGPT account.
  echo - A short code appears below. Open the link, enter the code,
  echo - and sign in. Do not close this window while you do it.
  echo.
  codex login --device-auth
  codex login status 2>nul | findstr /C:"Not logged in" >nul
  if not errorlevel 1 (
    echo.
    echo - Sign-in did not complete. Run this file again to retry.
    echo.
    pause
    exit /b 1
  )
)
echo - Signed in  OK

rem --- 5. run ----------------------------------------------------------------
echo.
echo - Starting the relay. Leave this window open while you use the analyzer.
echo - The analyzer finds this relay by itself. Nothing to type.
echo.
cd /d "%ROOT%"
set AI_CLI=codex-app
if "%PORT%"=="" set PORT=8080
node server/local/server.js

echo.
echo - Relay stopped. Press any key to close...
pause >nul
exit /b 0

:nodownload
echo.
echo - Could not download the analyzer files.
echo - Download the repository ZIP by hand, extract it, and run the copy of
echo - this file inside it instead:
echo.
echo -     "https://github.com/kubattery/Electrochemical-Analyzer"
echo.
pause
exit /b 1
