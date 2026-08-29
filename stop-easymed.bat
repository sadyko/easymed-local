@echo off
title Stop EasyMed Local
cd /d "%~dp0"

REM DEV_STOP_V1 - closing the terminal window does NOT stop the dev server.
REM node keeps running and keeps holding the port, so the next start fails
REM with 'port is already in use' and there is no window left to close. This
REM script is the way out, and server/index.js names it in that error.
REM
REM It stops the process on the port ONLY if that process is node. Anything
REM else on port 8000 belongs to some other program, and killing a stranger's
REM process because it happened to take our port would be a far worse bug
REM than the one this script exists to fix.

if "%EASYMED_PORT%"=="" set EASYMED_PORT=8000

echo Looking for Easy-Med on port %EASYMED_PORT% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort $env:EASYMED_PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $c) { Write-Host 'Nothing is listening on that port - Easy-Med is already stopped.'; exit 0 }; $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -ne 'node') { Write-Host ('Port is held by ' + $p.ProcessName + ' (PID ' + $p.Id + '), which is NOT Easy-Med. Refusing to stop it.'); exit 1 }; Stop-Process -Id $c.OwningProcess -Force; Write-Host ('Stopped Easy-Med (PID ' + $c.OwningProcess + '). Port ' + $env:EASYMED_PORT + ' is now free.')"

echo.
echo Press any key to close.
pause >nul
