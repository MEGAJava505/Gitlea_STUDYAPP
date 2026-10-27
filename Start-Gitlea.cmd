@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher\start.ps1"
set "result=%ERRORLEVEL%"
if not "%result%"=="0" pause
exit /b %result%
