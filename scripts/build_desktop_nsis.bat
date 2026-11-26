@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0.."
set "PYTHONPATH=%CD%"
set "ROOT=%CD%"

echo ========================================
echo  AndroidTVTestToolBox Desktop - NSIS Setup (local)
echo  Data stays in: %%LOCALAPPDATA%%\AndroidTVTestToolBox
echo ========================================
echo.

call "%ROOT%\build\select_python.bat"
if errorlevel 1 exit /b 1
echo Using: %PY_CMD%  (%PY%)
"%PY%" --version
echo.

"%PY%" "%ROOT%\build\write_build_version.py"
if errorlevel 1 exit /b 1

echo [0/5] Fetch / verify vendor resources
call "%ROOT%\build\fetch_platform_tools.bat"
if errorlevel 1 exit /b 1
"%PY%" "%ROOT%\build\verify_vendor_resources.py"
if errorlevel 1 exit /b 1

echo [1/5] Install build deps + embedded scrcpy
"%PY%" -m pip install -q -r "%ROOT%\build\requirements-api.txt"
"%PY%" -m pip install -q pyinstaller
echo [*] Python 3.10+: installing scrcpy embed deps...
"%PY%" -m pip install -q -r "%ROOT%\build\requirements-scrcpy.txt"
if errorlevel 1 (
  echo ERROR: pip install build\requirements-scrcpy.txt failed
  exit /b 1
)
"%PY%" -c "import av,cv2,imageio,py_scrcpy_sdk; print('[OK] embed scrcpy deps ready')"
if errorlevel 1 (
  echo ERROR: embedded scrcpy imports failed after pip install
  exit /b 1
)
set "TOOLBOX_EMBED_SCRCPY=1"
echo [OK] Full build with embedded scrcpy
echo.

cd /d "%ROOT%\desktop"
call npm install --cache "%CD%\.npm-cache"
if errorlevel 1 exit /b 1

echo [2/5] Build React UI
call npm run build
if errorlevel 1 exit /b 1

echo [3/5] Build Python API sidecar with embedded CPython / vendor / scrcpy
cd /d "%ROOT%"
set "TOOLBOX_EMBED_SCRCPY=1"
"%PY%" -m PyInstaller --noconfirm --clean "%ROOT%\build\spec\toolbox_api.spec"
if errorlevel 1 (
  echo ERROR: toolbox-api PyInstaller failed
  exit /b 1
)
if not exist "%ROOT%\dist\toolbox-api\_internal\vendor\platform-tools\adb.exe" (
  echo ERROR: PyInstaller output missing bundled adb
  exit /b 1
)
if not exist "%ROOT%\dist\toolbox-api\_internal\toolbox_embed_scrcpy.marker" (
  echo ERROR: missing toolbox_embed_scrcpy.marker in sidecar
  exit /b 1
)
"%PY%" "%ROOT%\scripts\verify_frozen_scrcpy.py" "%ROOT%\dist\toolbox-api"
if errorlevel 1 exit /b 1

robocopy "%ROOT%\dist\toolbox-api" "%ROOT%\desktop\extra\toolbox-api" /MIR /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 (
  echo ERROR: copy sidecar failed
  exit /b 1
)

echo [4/5] Package Electron NSIS Setup
cd /d "%ROOT%\desktop"
if not exist "%ROOT%\build\assets\toolbox.ico" (
  echo [*] Generating toolbox.ico
  "%PY%" "%ROOT%\build\assets\generate_toolbox_icon.py"
)
if not exist "%ROOT%\build\assets\toolbox.ico" (
  echo ERROR: missing %ROOT%\build\assets\toolbox.ico
  exit /b 1
)
mkdir "build" 2>nul
copy /Y "%ROOT%\build\assets\toolbox.ico" "build\icon.ico" >nul
copy /Y "%ROOT%\build\assets\toolbox.ico" "electron\icon.ico" >nul
if exist "%ROOT%\build\assets\toolbox_256.png" copy /Y "%ROOT%\build\assets\toolbox_256.png" "electron\icon.png" >nul
echo [OK] Synced toolbox.ico -^> desktop\build\icon.ico + electron\icon.ico
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win nsis --publish never
if errorlevel 1 exit /b 1

set "REL=%ROOT%\desktop\release"
set "APP_VER="
for /f "usebackq delims=" %%V in (`%PY_CMD% -c "import json;print(json.load(open(r'%ROOT%\desktop\package.json',encoding='utf-8'))['version'])"`) do set "APP_VER=%%V"
if not defined APP_VER (
  for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Content -Raw '%ROOT%\desktop\package.json' | ConvertFrom-Json).version"`) do set "APP_VER=%%V"
)
set "SETUP=%REL%\AndroidTVTestToolBox-Setup-!APP_VER!.exe"
if not exist "!SETUP!" (
  echo ERROR: expected setup not found: !SETUP!
  echo        APP_VER=!APP_VER!
  dir /b "%REL%\AndroidTVTestToolBox-Setup-*.exe"
  exit /b 1
)
if not exist "%REL%\latest.yml" (
  echo ERROR: latest.yml missing - auto-update feed will not work
  exit /b 1
)

set "OUT=%REL%\win-unpacked"
if exist "%OUT%\AndroidTVTestToolBox.exe" (
  "%PY%" "%ROOT%\scripts\verify_desktop_bundle.py" "%OUT%"
  if errorlevel 1 exit /b 1
)

echo [5/5] Finalize local release artifacts
rem 本地 release：只保留当前 Setup + blockmap
"%PY%" "%ROOT%\scripts\cleanup_old_setups.py" "%REL%" "!APP_VER!"

if not exist "%ROOT%\dist" mkdir "%ROOT%\dist" >nul 2>&1
copy /Y "!SETUP!" "%ROOT%\dist\" >nul
copy /Y "%REL%\latest.yml" "%ROOT%\dist\" >nul
if exist "!SETUP!.blockmap" copy /Y "!SETUP!.blockmap" "%ROOT%\dist\" >nul 2>&1
"%PY%" "%ROOT%\scripts\cleanup_old_setups.py" "%ROOT%\dist" "!APP_VER!"

echo.
echo ========================================
echo  NSIS pack ready (local).
echo  Setup:  !SETUP!
echo  Dist:   %ROOT%\dist\AndroidTVTestToolBox-Setup-!APP_VER!.exe
echo  Feed:   %ROOT%\dist\latest.yml
echo  Data:   %%LOCALAPPDATA%%\AndroidTVTestToolBox
echo ========================================
endlocal
