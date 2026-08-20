@echo off
title EasyMed Local
cd /d "%~dp0"
echo Starting EasyMed Local on http://localhost:8000 ...
node server\index.js
echo.
echo Server stopped. Press any key to close.
pause >nul
