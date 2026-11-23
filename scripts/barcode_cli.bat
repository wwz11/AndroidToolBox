@echo off
call "%~dp0_root.bat"
python -m tools.barcode_gen %*
if errorlevel 1 pause
