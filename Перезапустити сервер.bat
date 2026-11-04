@echo off
chcp 65001 >nul
title Askly: сервер
cd /d "%~dp0server"
set LOG=%~dp0server\install.log
echo [%date% %time%] Перезапуск >> "%LOG%"
rem Зупиняємо попередній сервер, який слухає порт 3000
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do (
  echo Зупиняю процес %%p >> "%LOG%"
  taskkill /F /PID %%p >> "%LOG%" 2>&1
)
timeout /t 2 /nobreak >nul
echo Сервер запущено. Не закривайте це вікно, поки працюєте з сайтом.
node --disable-warning=ExperimentalWarning server.js > "%~dp0server\server.log" 2>&1
pause
