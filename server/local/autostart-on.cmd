@echo off
rem ---------------------------------------------------------------------------
rem  Start the relay automatically when Windows signs in.
rem
rem  A web page cannot launch a program on the visitor's machine - browsers
rem  forbid it. So instead of the site starting the relay, the relay is already
rem  running and the site simply finds it.
rem
rem  This puts a shortcut in the user's Startup folder. No admin rights, no
rem  service, nothing written outside the user profile. Undo with
rem  autostart-off.cmd.
rem
rem  The window opens minimized, not hidden: it stays visible in the taskbar so
rem  it can be found and closed, and so a sign-in problem is not invisible.
rem
rem  Paths here contain non-ASCII characters, so no path is ever written into a
rem  text file - they are passed to PowerShell through the environment and
rem  stored in the shortcut, which is Unicode by design.
rem
rem  KEEP THIS FILE PURE ASCII. See start-codex.cmd for why.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal

set "RELAY_CMD=%~dp0start-codex.cmd"
set "LNK_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ESMPL Analyzer Relay.lnk"

if not exist "%RELAY_CMD%" (
  echo.
  echo - Could not find start-codex.cmd next to this file.
  echo - Run this from inside the analyzer folder.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK_PATH);" ^
  "$s.TargetPath = $env:RELAY_CMD;" ^
  "$s.WorkingDirectory = (Split-Path -Parent $env:RELAY_CMD);" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'ESMPL Analyzer - Codex relay';" ^
  "$s.Save()"

if not exist "%LNK_PATH%" (
  echo.
  echo - Could not create the startup shortcut.
  echo.
  pause
  exit /b 1
)

echo.
echo - Done. The relay will start by itself from the next sign-in.
echo - It opens minimized in the taskbar. Closing that window stops the relay
echo - until the next sign-in.
echo.
echo - To undo this, run autostart-off.cmd
echo.
echo - Starting it now as well, so you do not have to sign out.
echo - Look for a minimized window in the taskbar.
echo.
start "" /min "%RELAY_CMD%"
rem  No "timeout" here on purpose: it needs a real console and hangs when this
rem  script's input is redirected.
exit /b 0
