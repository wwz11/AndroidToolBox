@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

REM One-click upgrade for portable AndroidTVTestToolBox Desktop.
REM Usage:
REM   1) Unzip the NEW pack anywhere
REM   2) Double-click 升级.bat inside the NEW pack
REM Config / reports stay in %%LOCALAPPDATA%%\AndroidTVTestToolBox (not overwritten)

set "APP_EXE=AndroidTVTestToolBox.exe"
set "LEGACY_EXE=Toolbox.exe"
set "NEW=%~dp0"
if "%NEW:~-1%"=="\" set "NEW=%NEW:~0,-1%"

set "NEW_EXE="
if exist "%NEW%\%APP_EXE%" set "NEW_EXE=%APP_EXE%"
if not defined NEW_EXE if exist "%NEW%\%LEGACY_EXE%" set "NEW_EXE=%LEGACY_EXE%"
if not defined NEW_EXE (
  echo [ERROR] %APP_EXE% not found next to this script:
  echo   %NEW%
  echo Put 升级.bat inside the new AndroidTVTestToolBox-Desktop folder.
  pause
  exit /b 1
)

set "DATA=%LOCALAPPDATA%\AndroidTVTestToolBox"
if not exist "%DATA%\" if exist "%LOCALAPPDATA%\Toolbox\" set "DATA=%LOCALAPPDATA%\Toolbox"
set "OLD="
if exist "%DATA%\install_dir.txt" (
  set /p OLD=<"%DATA%\install_dir.txt"
)
if defined OLD (
  set "OLD=!OLD:"=!"
  for /f "tokens=* delims= " %%A in ("!OLD!") do set "OLD=%%A"
)

if not defined OLD (
  echo First upgrade: drag your CURRENT %APP_EXE% onto this window, then Enter.
  echo Or type the full path to the current install folder.
  set /p "OLD=Current install: "
  set "OLD=!OLD:"=!"
)

if exist "!OLD!\%APP_EXE%" goto old_ok
if exist "!OLD!\%LEGACY_EXE%" goto old_ok
if exist "!OLD!" (
  for %%I in ("!OLD!") do set "OLD=%%~dpI"
  if "!OLD:~-1!"=="\" set "OLD=!OLD:~0,-1%"
)
if exist "!OLD!\%APP_EXE%" goto old_ok
if exist "!OLD!\%LEGACY_EXE%" goto old_ok
echo [ERROR] Current install not found: !OLD!
echo Run the old app once, or pass the folder that contains %APP_EXE%.
pause
exit /b 1
:old_ok

if /I "!OLD!"=="!NEW!" (
  echo [OK] Already running from the install folder. Nothing to copy.
  echo Data dir: %DATA%
  pause
  exit /b 0
)

echo ========================================
echo  Upgrade AndroidTVTestToolBox Desktop
echo  From: %NEW%
echo  To:   !OLD!
echo  Data: %DATA%  ^(kept^)
echo ========================================
echo.

echo [*] Stopping AndroidTVTestToolBox / toolbox-api ...
taskkill /F /IM %APP_EXE% >nul 2>&1
taskkill /F /IM %LEGACY_EXE% >nul 2>&1
taskkill /F /IM toolbox-api.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [*] Copying new files ...
robocopy "%NEW%" "!OLD!" /E /IS /IT /R:2 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np
set "RC=!ERRORLEVEL!"
if !RC! GEQ 8 (
  echo [ERROR] robocopy failed, code=!RC!
  pause
  exit /b 1
)

> "%DATA%\install_dir.txt" echo !OLD!

echo.
echo [OK] Upgrade done. Starting AndroidTVTestToolBox...
if exist "!OLD!\%APP_EXE%" (
  start "" "!OLD!\%APP_EXE%"
) else (
  start "" "!OLD!\%LEGACY_EXE%"
)
echo Data kept at: %DATA%
endlocal
exit /b 0
