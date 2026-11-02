@echo off
rem ---------------------------------------------------------------------------
rem  ESMPL Analyzer - Codex subscription, reachable from other PCs on the LAN.
rem
rem  Same as start-codex.cmd but binds to every interface instead of only this
rem  PC. The server prints the address other machines should use, together with
rem  a one-time token that outside requests must carry.
rem
rem  Close this window when you are done. While it runs, anyone who can reach
rem  this machine's address and knows the token can spend your subscription.
rem
rem  KEEP THIS FILE PURE ASCII - see start-codex.cmd for the reason.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0..\.."

set AI_CLI=codex-app
set ALLOW_LAN=1
if "%PORT%"=="" set PORT=8080

node server/local/server.js

echo.
echo - Server stopped. Press any key to close...
pause >nul
