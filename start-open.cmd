@echo off
REM Launch Conclave in open-access mode (no session token) for local solo use.
REM Double-click this file, or run it from a terminal. Ctrl+C to stop.
cd /d "%~dp0"
set CONCLAVE_OPEN_ACCESS=1
node src/server.js
pause
