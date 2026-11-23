@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0.."
set "PYTHONPATH=%CD%"
set "ROOT=%CD%"
set "NAS_PUBLISH=\\nas.we\Department_files\Testing\public\测试工具\ToolBox"

echo ========================================
echo  SEIAndroidTVTestToolBox Desktop - NSIS Setup + auto-update
echo  Update URL default: https://github.com/wwz11/AndroidToolBox/releases/latest/download
echo  Data stays in: %%LOCALAPPDATA%%\SEIAndroidTVTestToolBox
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
set "SETUP=%REL%\SEIAndroidTVTestToolBox-Setup-!APP_VER!.exe"
if not exist "!SETUP!" (
  echo ERROR: expected setup not found: !SETUP!
  echo        APP_VER=!APP_VER!
  dir /b "%REL%\SEIAndroidTVTestToolBox-Setup-*.exe"
  exit /b 1
)
if not exist "%REL%\latest.yml" (
  echo ERROR: latest.yml missing - auto-update feed will not work
  exit /b 1
)

set "OUT=%REL%\win-unpacked"
if exist "%OUT%\SEIAndroidTVTestToolBox.exe" (
  "%PY%" "%ROOT%\scripts\verify_desktop_bundle.py" "%OUT%"
  if errorlevel 1 exit /b 1
)

echo [5/5] Finalize release artifacts (GitHub Releases)
set "PUBLISH_OK=0"

rem 本地 release：只保留当前 Setup + blockmap
"%PY%" "%ROOT%\scripts\cleanup_old_setups.py" "%REL%" "!APP_VER!"

if not "%TOOLBOX_PUBLISH_NAS%"=="1" (
  echo [5/5] NAS publish disabled - upload Setup.exe + latest.yml to GitHub Releases
) else if exist "%NAS_PUBLISH%\" (
  copy /Y "!SETUP!" "%NAS_PUBLISH%\" >nul
  if errorlevel 1 (
    echo WARN: copy Setup.exe to NAS failed
  ) else (
    copy /Y "%REL%\latest.yml" "%NAS_PUBLISH%\" >nul
    if errorlevel 1 (
      echo WARN: copy latest.yml to NAS failed
    ) else (
      if exist "!SETUP!.blockmap" copy /Y "!SETUP!.blockmap" "%NAS_PUBLISH%\" >nul 2>&1
      rem NAS：删掉旧版 Setup / blockmap，只留最新
      "%PY%" "%ROOT%\scripts\cleanup_old_setups.py" "%NAS_PUBLISH%" "!APP_VER!"
      set "PUBLISH_OK=1"
      echo [OK] Published to %NAS_PUBLISH%
    )
  )
) else (
  echo WARN: NAS path not reachable from this machine:
  echo       %NAS_PUBLISH%
  echo       Manually copy these files there:
  echo         !SETUP!
  echo         %REL%\latest.yml
)

echo.
echo ========================================
echo  NSIS pack ready.
echo  Setup:  !SETUP!
echo  Feed:   %REL%\latest.yml
if "!PUBLISH_OK!"=="1" (
  echo  NAS:    %NAS_PUBLISH%
) else (
  echo  NAS:    copy Setup.exe + latest.yml to:
  echo          %NAS_PUBLISH%
)
echo  GitHub: https://github.com/wwz11/AndroidToolBox/releases
echo  Update URL default: https://github.com/wwz11/AndroidToolBox/releases/latest/download
echo  Override: TOOLBOX_UPDATE_URL or %%LOCALAPPDATA%%\SEIAndroidTVTestToolBox\update-url.txt
echo  Data: %%LOCALAPPDATA%%\SEIAndroidTVTestToolBox
echo ========================================
endlocal
