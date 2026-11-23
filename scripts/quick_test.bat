@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."
set "PYTHONPATH=%CD%"

echo ========================================
echo   AndroidTVTestToolBox Quick Test
echo ========================================
echo Project: %CD%
echo.

call "%CD%\build\select_python.bat"
if errorlevel 1 (
    echo [ERROR] Python 3.10+ not found.
    pause
    exit /b 1
)

echo Using: %PY_CMD% (%PY%)
"%PY%" --version
echo.

echo [1/3] Running Python automated unit tests...
"%PY%" -m unittest discover -s tests -p "test_*.py"
if errorlevel 1 (
    echo [FAIL] Unit tests failed!
    pause
    exit /b 1
)
echo [OK] All unit tests passed!
echo.

echo [2/3] Checking ADB runtime resolution...
"%PY%" -c "from tools.adb_runtime import resolve_adb_exe, adb_available; print('ADB exe:', resolve_adb_exe()); print('ADB available:', adb_available())"
echo.

echo [3/3] Checking log manager status...
"%PY%" -c "from tools.log_manager import get_logs_stats; s = get_logs_stats(); print(f'Log files: {s[\"total_count\"]}, Total size: {s[\"total_size_str\"]}')"
echo.

echo ========================================
echo   All Quick Tests Passed Successfully!
echo ========================================
pause
