@echo off
setlocal
if exist "%~dp0Multica.exe" (
  start "Multica" "%~dp0Multica.exe"
  exit /b 0
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mj-automation\scripts\portable\portable_start.ps1"
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
