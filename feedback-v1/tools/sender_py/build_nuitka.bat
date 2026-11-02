@echo off
chcp 65001 >nul
title JiFang Feedback Sender - Nuitka Build Center

cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Python not found in PATH!
    echo Please make sure Python 3.10+ is installed and added to PATH.
    pause
    exit /b 1
)

python "%~dp0build_nuitka.py" %*
if errorlevel 1 (
    echo.
    echo [ERROR] Build execution failed!
    pause
    exit /b 1
)

pause
exit /b 0
