@echo off
chcp 65001 >nul
setlocal
title dsh-voice-doubao - doctor

rem Use the Node that ships with DeepSeek Harness; fall back to PATH.
set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE%" goto run
where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE=node"

:run
"%NODE%" "%~dp0doctor.mjs" %*
echo.
echo ---------------------------------------------------------------
echo  Anything marked [x] above tells you exactly what to fix.
echo ---------------------------------------------------------------
pause
exit /b 0

:nonode
echo [X] Cannot find Node.js.
echo     Install DeepSeek Harness first, or put "node" in PATH.
echo.
pause
exit /b 1
