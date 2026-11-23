@echo off
call "%~dp0_root.bat"
python -m tools.serial_prefix %*
if errorlevel 1 pause
