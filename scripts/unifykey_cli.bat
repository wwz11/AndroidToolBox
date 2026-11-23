@echo off
call "%~dp0_root.bat"
python -m tools.unifykey %*
if errorlevel 1 pause
