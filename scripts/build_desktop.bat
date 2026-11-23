@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0.."
set "PYTHONPATH=%CD%"
set "ROOT=%CD%"

echo ========================================
echo  SEIAndroidTVTestToolBox Desktop - zero-deps portable pack
echo  Bundles: Electron + Python API + adb + vendor + embed scrcpy
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
set "ZIP_NAME=%ROOT%\dist\SEIAndroidTVTestToolBox-Desktop_portable_!APP_VER!.zip"

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

echo [4/6] Package Electron portable folder
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
call npx electron-builder --win dir
if errorlevel 1 exit /b 1

echo [5/6] Verify portable bundle
set "OUT=%ROOT%\desktop\release\win-unpacked"
if not exist "%OUT%\SEIAndroidTVTestToolBox.exe" (
  if exist "%ROOT%\desktop\release-new\win-unpacked\SEIAndroidTVTestToolBox.exe" set "OUT=%ROOT%\desktop\release-new\win-unpacked"
)
"%PY%" "%ROOT%\scripts\verify_desktop_bundle.py" "%OUT%"
if errorlevel 1 exit /b 1
"%PY%" "%ROOT%\scripts\verify_frozen_scrcpy.py" "%OUT%\resources\toolbox-api"
if errorlevel 1 exit /b 1

echo [6/6] Mirror + zip
robocopy "%OUT%" "%ROOT%\dist\SEIAndroidTVTestToolBox-Desktop" /MIR /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 (
  echo WARN: copy to dist\SEIAndroidTVTestToolBox-Desktop failed
) else (
  echo [OK] also mirrored to: %ROOT%\dist\SEIAndroidTVTestToolBox-Desktop
)

copy /Y "%ROOT%\scripts\upgrade_desktop.bat" "%OUT%\升级.bat" >nul
if exist "%ROOT%\dist\SEIAndroidTVTestToolBox-Desktop" copy /Y "%ROOT%\scripts\upgrade_desktop.bat" "%ROOT%\dist\SEIAndroidTVTestToolBox-Desktop\升级.bat" >nul

echo [*] Creating portable zip ...
if exist "!ZIP_NAME!" del /f /q "!ZIP_NAME!" >nul 2>&1
set "ZIP_OK=0"
where tar >nul 2>&1
if not errorlevel 1 (
  pushd "%ROOT%\dist"
  tar -a -cf "SEIAndroidTVTestToolBox-Desktop_portable_!APP_VER!.zip" "SEIAndroidTVTestToolBox-Desktop"
  if not errorlevel 1 if exist "SEIAndroidTVTestToolBox-Desktop_portable_!APP_VER!.zip" set "ZIP_OK=1"
  popd
)
if "!ZIP_OK!"=="0" (
  powershell -NoProfile -Command "Compress-Archive -LiteralPath '%ROOT%\dist\SEIAndroidTVTestToolBox-Desktop' -DestinationPath '!ZIP_NAME!' -Force -CompressionLevel Optimal"
  if exist "!ZIP_NAME!" set "ZIP_OK=1"
)

echo.
echo ========================================
echo  Portable pack ready.
echo  Folder: %OUT%\SEIAndroidTVTestToolBox.exe
echo  Folder: %ROOT%\dist\SEIAndroidTVTestToolBox-Desktop\SEIAndroidTVTestToolBox.exe
if "!ZIP_OK!"=="1" (
  echo  Zip:    !ZIP_NAME!
) else (
  echo  Zip:    FAILED - close Explorer under dist and retry zip step
)
echo  Upgrade: run 升级.bat inside the NEW pack.
echo  Data: %%LOCALAPPDATA%%\SEIAndroidTVTestToolBox
echo  Tip: for NSIS installer + NAS auto-update, run scripts\build_desktop_nsis.bat
echo       then put SEIAndroidTVTestToolBox-Setup-*.exe + latest.yml into
echo       \\nas.we\Department_files\Testing\public\测试工具\ToolBox
echo ========================================
endlocal
