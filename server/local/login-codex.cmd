@echo off
rem ---------------------------------------------------------------------------
rem  Log in to Codex with a ChatGPT account (device code flow).
rem
rem  KEEP THIS FILE PURE ASCII. See start-codex.cmd for why: "chcp 65001" plus
rem  a UTF-8 batch file makes cmd.exe misparse later lines, and a line that was
rem  only meant to be printed can end up being executed.
rem
rem  Device code flow is used instead of the default browser flow because it
rem  needs no localhost callback port and no browser auto-open. You open a URL
rem  yourself and type a short code.
rem
rem  Leave this window open until it says you are logged in. The code is only
rem  valid while this process runs.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal

where codex >nul 2>nul
if errorlevel 1 goto nocodex

codex login --device-auth

echo.
codex login status
echo.
echo - Press any key to close...
pause >nul
exit /b 0

:nocodex
echo.
echo - Codex CLI not found on PATH.
echo - Install it first, then run this file again. Command (quoted on purpose,
echo - so it cannot run by accident - retype it without the quotes):
echo.
echo -     "npm install -g @openai/codex"
echo.
echo - Press any key to close...
pause >nul
exit /b 1
