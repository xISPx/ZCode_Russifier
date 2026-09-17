@echo off
chcp 65001 >nul
title ZCode Russifier
set "LOG=%TEMP%\zcode-russifier.log"
set "NODEEXE=%~dp0node.exe"
if not exist "%NODEEXE%" set "NODEEXE=node"
echo ============================================
echo   ZCode Russifier — русский интерфейс ZCode
echo ============================================
echo Журнал: %LOG%
"%NODEEXE%" "%~dp0russify.js" > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
type "%LOG%"
echo.
if "%RC%"=="0" echo [OK] Русификация применена. Перезапустите ZCode.
if not "%RC%"=="0" echo [ОШИБКА] код %RC% — подробности в журнале выше
echo Журнал: %LOG%
pause
exit /b %RC%
