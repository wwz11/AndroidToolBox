@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\.."

set VENDOR=vendor\platform-tools
set ADB_EXE=%VENDOR%\adb.exe

if exist "%ADB_EXE%" (
    echo [OK] platform-tools already present: %ADB_EXE%
    exit /b 0
)

echo [*] Downloading Android platform-tools for Windows...
if not exist "vendor" mkdir "vendor"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$zip = Join-Path $env:TEMP ('platform-tools-' + [guid]::NewGuid().ToString() + '.zip');" ^
  "$extract = Join-Path $env:TEMP ('platform-tools-extract-' + [guid]::NewGuid().ToString());" ^
  "Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $zip;" ^
  "Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force;" ^
  "if (Test-Path 'vendor\platform-tools') { Remove-Item -Recurse -Force 'vendor\platform-tools' };" ^
  "Move-Item -LiteralPath (Join-Path $extract 'platform-tools') -Destination 'vendor\platform-tools';" ^
  "Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue;" ^
  "Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue;"

if not exist "%ADB_EXE%" (
    echo [ERROR] Failed to fetch platform-tools. Check network or download manually:
    echo   https://developer.android.com/tools/releases/platform-tools
    exit /b 1
)

echo [OK] platform-tools: %ADB_EXE%
exit /b 0
