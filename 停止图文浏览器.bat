@echo off
title Stop Tuwen Browser
echo Stopping tuwen-browser service (ports 8080-8089) ...
set killed=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr /R ":808[0-9] "') do (
  taskkill /f /pid %%a >nul 2>nul
  if not errorlevel 1 set killed=1
)
if %killed%==1 (echo Done. Service stopped.) else (echo No running service found.)
echo You can now close the browser window manually.
pause >nul
