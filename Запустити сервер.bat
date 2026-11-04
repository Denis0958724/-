@echo off
chcp 65001 >nul
title Askly: сервер
cd /d "%~dp0server"
set LOG=%~dp0server\install.log
echo [%date% %time%] Старт > "%LOG%"

rem 1. Node.js 22.13 або новіший
set NODEOK=0
where node >nul 2>nul && node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" && set NODEOK=1
if "%NODEOK%"=="0" (
  echo Node.js 22.13+ не знайдено. Встановлюю через winget...
  echo Встановлюю Node.js LTS через winget >> "%LOG%"
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements >> "%LOG%" 2>&1
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
node -v >> "%LOG%" 2>&1
if errorlevel 1 (
  echo Node.js не встановився. Подробиці в server\install.log
  echo НЕ ВДАЛОСЯ: node >> "%LOG%"
  pause
  exit /b 1
)

rem 2. Бібліотеки
if not exist node_modules\nodemailer (
  echo Встановлюю бібліотеки, це хвилина-дві...
  call npm install --no-audit --no-fund >> "%LOG%" 2>&1
)
if not exist node_modules\nodemailer (
  echo npm install не вдався. Подробиці в server\install.log
  echo НЕ ВДАЛОСЯ: npm install >> "%LOG%"
  pause
  exit /b 1
)
echo ГОТОВО: бібліотеки на місці >> "%LOG%"

rem 3. Запуск і браузер
start "" http://localhost:3000
echo Сервер запущено. Не закривайте це вікно, поки працюєте з сайтом.
call npm start
pause
