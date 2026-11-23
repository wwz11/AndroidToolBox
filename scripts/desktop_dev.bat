@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0.."
set "ROOT=%CD%"
set "PYTHONPATH=%ROOT%"
set "TOOLBOX_API_PORT=17831"

echo ========================================
echo  Dev mode - no packaging needed
echo  Python API: hot reload
echo  React: Vite HMR
echo  Electron: http://127.0.0.1:5173
echo  Edit code and refresh; pack only for release
echo ========================================
echo.

REM free ports held by previous Vite / API / Toolbox
for %%P in (17831 5173) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    echo [dev] kill pid %%A on :%%P
    taskkill /F /PID %%A >nul 2>&1
  )
)

pip install -q -r "%ROOT%\build\requirements-api.txt"
cd /d "%ROOT%\desktop"
if not exist node_modules (
  call npm install --cache "%CD%\.npm-cache"
)

call npm run dev
endlocal
