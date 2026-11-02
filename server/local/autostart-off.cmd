@echo off
rem ---------------------------------------------------------------------------
rem  Undo autostart-on.cmd: the relay no longer starts with Windows.
rem  Anything already running keeps running until its window is closed.
rem
rem  KEEP THIS FILE PURE ASCII. See start-codex.cmd for why.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal

set "LNK_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ESMPL Analyzer Relay.lnk"

if not exist "%LNK_PATH%" (
  echo.
  echo - Autostart was not set up. Nothing to undo.
  echo.
  pause
  exit /b 0
)

del "%LNK_PATH%"

if exist "%LNK_PATH%" (
  echo.
  echo - Could not remove the startup shortcut.
  echo - Remove it by hand: press Win+R, type  shell:startup  and delete
  echo - the "ESMPL Analyzer Relay" entry.
  echo.
  pause
  exit /b 1
)

echo.
echo - Done. The relay no longer starts with Windows.
echo - A relay window that is open right now keeps running until you close it.
echo.
pause
exit /b 0
