@echo off
rem ---------------------------------------------------------------------------
rem  ESMPL Analyzer - start with Codex subscription (AI_CLI=codex-app)
rem
rem  KEEP THIS FILE PURE ASCII.
rem  "chcp 65001" makes cmd.exe misparse later lines of a UTF-8 batch file:
rem  the "echo" prefix can be dropped and the rest of the line executed.
rem  An earlier version echoed a global-install command and cmd actually RAN
rem  it. So: never put a runnable command in this file, not even inside echo
rem  or rem. All human-readable text is printed by Node instead, which handles
rem  UTF-8 correctly once the code page is 65001.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0..\.."

set AI_CLI=codex-app
if "%PORT%"=="" set PORT=8080

node server/local/server.js

echo.
echo Server stopped. Press any key to close...
pause >nul
