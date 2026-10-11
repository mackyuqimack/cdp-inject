@echo off
title CDP Injector
cd /d "%~dp0"
echo ============================================
echo   CDP Injector - target: 127.0.0.1:9222
echo   Scripts dir: %~dp0scripts
echo   Close this window to stop injecting
echo ============================================
node inject.js
echo.
echo Program exited. Press any key to close...
pause >nul
