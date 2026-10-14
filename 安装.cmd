@echo off
chcp 65001 >nul
setlocal
title dsh-voice-doubao - install

rem Use the Node that ships with DeepSeek Harness; fall back to PATH.
set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE%" goto run
where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE=node"

:run
"%NODE%" "%~dp0install.mjs" %*
echo.
echo ---------------------------------------------------------------
echo  Next: fill in your API key, then restart DeepSeek Harness.
echo  See "使用说明.md" (section 2) for how to get a free key.
echo ---------------------------------------------------------------
pause
exit /b 0

:nonode
echo [X] Cannot find Node.js.
echo     Install DeepSeek Harness first, or put "node" in PATH.
echo.
pause
exit /b 1
