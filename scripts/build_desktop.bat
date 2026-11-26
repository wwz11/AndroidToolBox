@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0.."
set "PYTHONPATH=%CD%"
set "ROOT=%CD%"

echo ========================================
echo  AndroidTVTestToolBox Desktop - all-in-one pack
echo  Bundles: NSIS Setup (.exe) + Portable + Upgrade zip
echo  Target PC needs NO Python / adb install
echo ========================================
echo.

call "%ROOT%\build\select_python.bat"
if errorlevel 1 exit /b 1
echo Using: %PY_CMD%  (%PY%)
"%PY%" --version
echo.

"%PY%" "%ROOT%\build\write_build_version.py"
set "APP_VER="
for /f "usebackq delims=" %%V in (`%PY_CMD% -c "import json;print(json.load(open(r'%ROOT%\desktop\package.json',encoding='utf-8'))['version'])"`) do set "APP_VER=%%V"
if not defined APP_VER (
  for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Content -Raw '%ROOT%\desktop\package.json' | ConvertFrom-Json).version"`) do set "APP_VER=%%V"
)
if not defined APP_VER set "APP_VER=0.0.0"
set "ZIP_NAME=%ROOT%\dist\AndroidTVTestToolBox-Desktop_portable_!APP_VER!.zip"
set "UPGRADE_ZIP_NAME=%ROOT%\dist\AndroidTVTestToolBox-Desktop_upgrade_!APP_VER!.zip"

echo [0/6] Fetch / verify vendor resources
call "%ROOT%\build\fetch_platform_tools.bat"
if errorlevel 1 exit /b 1
"%PY%" "%ROOT%\build\verify_vendor_resources.py"
if errorlevel 1 exit /b 1

echo [1/6] Install build deps + embedded scrcpy
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
echo TOOLBOX_EMBED_SCRCPY=!TOOLBOX_EMBED_SCRCPY!
echo.

cd /d "%ROOT%\desktop"
if not exist node_modules goto npm_install
call npm install --cache "%CD%\.npm-cache"
goto npm_done
:npm_install
call npm install --cache "%CD%\.npm-cache"
:npm_done

echo [2/6] Build React UI
call npm run build
if errorlevel 1 exit /b 1

echo [3/6] Build Python API sidecar with embedded CPython / vendor / scrcpy
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
echo [OK] toolbox_embed_scrcpy.marker bundled in toolbox-api\_internal
"%PY%" "%ROOT%\scripts\verify_frozen_scrcpy.py" "%ROOT%\dist\toolbox-api"
if errorlevel 1 exit /b 1

robocopy "%ROOT%\dist\toolbox-api" "%ROOT%\desktop\extra\toolbox-api" /MIR /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 (
  echo ERROR: copy sidecar failed
  exit /b 1
)

echo [4/6] Package Electron (NSIS Setup .exe + win-unpacked)
cd /d "%ROOT%\desktop"
if not exist "%ROOT%\build\assets\toolbox.ico" (
  "%PY%" "%ROOT%\build\assets\generate_toolbox_icon.py"
)
mkdir "build" 2>nul
if exist "%ROOT%\build\assets\toolbox.ico" (
  copy /Y "%ROOT%\build\assets\toolbox.ico" "build\icon.ico" >nul
  copy /Y "%ROOT%\build\assets\toolbox.ico" "electron\icon.ico" >nul
  if exist "%ROOT%\build\assets\toolbox_256.png" copy /Y "%ROOT%\build\assets\toolbox_256.png" "electron\icon.png" >nul
)
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win nsis --publish never
if errorlevel 1 exit /b 1

echo [5/6] Verify bundle + NSIS Setup
set "REL=%ROOT%\desktop\release"
set "OUT=%REL%\win-unpacked"
if not exist "%OUT%\AndroidTVTestToolBox.exe" (
  if exist "%ROOT%\desktop\release-new\win-unpacked\AndroidTVTestToolBox.exe" set "OUT=%ROOT%\desktop\release-new\win-unpacked"
)
"%PY%" "%ROOT%\scripts\verify_desktop_bundle.py" "%OUT%"
if errorlevel 1 exit /b 1
"%PY%" "%ROOT%\scripts\verify_frozen_scrcpy.py" "%OUT%\resources\toolbox-api"
if errorlevel 1 exit /b 1

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

echo [6/6] Mirror + Setup .exe + portable zip + upgrade zip
"%PY%" "%ROOT%\scripts\cleanup_old_setups.py" "%REL%" "!APP_VER!"
if not exist "%ROOT%\dist" mkdir "%ROOT%\dist" >nul 2>&1
copy /Y "!SETUP!" "%ROOT%\dist\" >nul
copy /Y "%REL%\latest.yml" "%ROOT%\dist\" >nul
if exist "!SETUP!.blockmap" copy /Y "!SETUP!.blockmap" "%ROOT%\dist\" >nul 2>&1
"%PY%" "%ROOT%\scripts\cleanup_old_setups.py" "%ROOT%\dist" "!APP_VER!"

if exist "%OUT%\升级.bat" del /f /q "%OUT%\升级.bat" >nul 2>&1
robocopy "%OUT%" "%ROOT%\dist\AndroidTVTestToolBox-Desktop" /MIR /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 (
  echo WARN: copy to dist\AndroidTVTestToolBox-Desktop failed
) else (
  echo [OK] also mirrored to: %ROOT%\dist\AndroidTVTestToolBox-Desktop
)

echo [*] Creating portable zip ...
call :make_zip "!ZIP_NAME!" ZIP_OK

echo [*] Creating upgrade zip ...
copy /Y "%ROOT%\scripts\upgrade_desktop.bat" "%ROOT%\dist\AndroidTVTestToolBox-Desktop\升级.bat" >nul
call :make_zip "!UPGRADE_ZIP_NAME!" UPGRADE_ZIP_OK
del /f /q "%ROOT%\dist\AndroidTVTestToolBox-Desktop\升级.bat" >nul 2>&1

echo.
echo ========================================
echo  All packs ready (Setup + Portable + Upgrade).
echo  Setup:       %ROOT%\dist\AndroidTVTestToolBox-Setup-!APP_VER!.exe
echo  Feed:        %ROOT%\dist\latest.yml
echo  Folder:      %OUT%\AndroidTVTestToolBox.exe
echo  Folder:      %ROOT%\dist\AndroidTVTestToolBox-Desktop\AndroidTVTestToolBox.exe
if "!ZIP_OK!"=="1" (
  echo  Portable:    !ZIP_NAME!
) else (
  echo  Portable:    FAILED - close Explorer under dist and retry zip step
)
if "!UPGRADE_ZIP_OK!"=="1" (
  echo  Upgrade:     !UPGRADE_ZIP_NAME!
) else (
  echo  Upgrade:     FAILED - close Explorer under dist and retry zip step
)
echo  Upgrade usage: unzip Upgrade zip and run 升级.bat, or run Setup .exe.
echo  Data: %%LOCALAPPDATA%%\AndroidTVTestToolBox
echo ========================================
endlocal
goto :eof

:make_zip
set "%~2=0"
set "_TARGET_ZIP=%~1"
if exist "!_TARGET_ZIP!" del /f /q "!_TARGET_ZIP!" >nul 2>&1
where tar >nul 2>&1
if not errorlevel 1 (
  pushd "%ROOT%\dist"
  tar -a -cf "!_TARGET_ZIP!" "AndroidTVTestToolBox-Desktop"
  if not errorlevel 1 if exist "!_TARGET_ZIP!" set "%~2=1"
  popd
)
if "!%~2!"=="0" (
  powershell -NoProfile -Command "Compress-Archive -LiteralPath '%ROOT%\dist\AndroidTVTestToolBox-Desktop' -DestinationPath '!_TARGET_ZIP!' -Force -CompressionLevel Optimal"
  if exist "!_TARGET_ZIP!" set "%~2=1"
)
exit /b 0
