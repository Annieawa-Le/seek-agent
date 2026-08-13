@echo off
chcp 65001
cd /d "%~dp0"

echo.
echo [dev] Opening Dev Environment...
echo.

echo [1/3] front end...
cd electron\renderer
call npx vite build >nul 2>&1
if %errorlevel% neq 0 (
  echo [dev] Frontend build failed. Re-running to show errors:
  call npx vite build
  echo.
  echo [dev] Build failed with exit code %errorlevel%
  pause
  exit /b 1
)
echo [1/3] Frontend build finished.

echo [2/3] Compiling Agent...
cd ..\..
call npx tsc -p tsconfig.json --outDir dist\agent --skipLibCheck >nul 2>&1
echo [2/3] Agent Compiled

node scripts\build-agent.mjs >nul 2>&1

echo [3/3] Opening Electron...
echo.
echo  ReRunning this script after you finished modifying.
echo.
set NODE_ENV=development
npx electron .

