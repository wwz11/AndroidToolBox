@echo off
REM Pick Python for packaging: py launcher or python from PATH (3.10+).
set "PY="
set "PY_CMD="

if not "%TOOLBOX_BUILD_PY%"=="" (
    set "PY_CMD=%TOOLBOX_BUILD_PY%"
    goto :resolve
)

where py >nul 2>&1
if not errorlevel 1 (
    for %%V in (3.14 3.13 3.12 3.11 3.10) do (
        py -%%V -c "pass" 2>nul
        if not errorlevel 1 (
            set "PY_CMD=py -%%V"
            goto :resolve
        )
    )
)

REM Fallback to standard python from PATH
where python >nul 2>&1
if not errorlevel 1 (
    python -c "import sys; exit(0 if sys.version_info >= (3, 10) else 1)" 2>nul
    if not errorlevel 1 (
        set "PY_CMD=python"
        goto :resolve
    )
)

echo [ERROR] Python 3.10+ not found. Install 3.10+ or add it to PATH.
exit /b 1

:resolve
for /f "delims=" %%E in ('%PY_CMD% "%~dp0print_py_exe.py" 2^>nul') do set "PY=%%E"
if not defined PY (
    for /f "delims=" %%E in ('where python 2^>nul') do (
        if not defined PY set "PY=%%E"
    )
)
if not defined PY (
    echo [ERROR] Cannot resolve Python executable for %PY_CMD%
    exit /b 1
)
exit /b 0
