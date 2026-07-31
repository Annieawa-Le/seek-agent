@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo [1/3] 清理残留 Electron 进程...
taskkill /f /im electron.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] 清理残留 agent 子进程...
powershell -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'electron-entry' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo [3/3] 启动 Seek Agent...
echo.
call dev-electron.bat
