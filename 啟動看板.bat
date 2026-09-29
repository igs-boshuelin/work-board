@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 接單看板
node server.js
echo.
echo 服務已結束，按任意鍵關閉視窗。
pause >nul
