@echo off
chcp 65001 >nul
echo [INFO] Legacy Tk installer pack is retired.
echo        Use Desktop portable pack instead: scripts\build_desktop.bat
echo.
cd /d "%~dp0.."
call scripts\build_desktop.bat %*
exit /b %ERRORLEVEL%
