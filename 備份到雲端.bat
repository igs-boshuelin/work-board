@echo off
chcp 65001 > nul
rem 加密備份到 GitHub。由「工作排程器」定時呼叫，設定方式見 README §8.7。
rem 內容跟上次一樣的話會直接跳過，不會產生 commit。
cd /d "%~dp0"
echo ---------------------------------------- >> backup-vault.log
node backup-vault.js push >> backup-vault.log 2>&1
