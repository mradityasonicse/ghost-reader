@echo off
echo ====================================================
echo Stopping WhatsApp Ghost Server and Cloudflare Tunnel
echo ====================================================

rem 1. Kill cloudflared process
taskkill /F /IM cloudflared.exe >nul 2>&1
echo [OK] Cloudflare tunnels stopped.

rem 2. Kill node process listening on port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
    echo [OK] Killed backend on port 3000 (PID %%a).
)

rem 3. If server.pid exists, read launcher PID and kill it
if exist "server.pid" (
    del /f /q "server.pid" >nul 2>&1
)

echo [OK] WhatsApp Ghost Server has been completely stopped.
echo ====================================================
pause
