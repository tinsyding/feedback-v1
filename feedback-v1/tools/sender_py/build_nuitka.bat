@echo off
chcp 65001 >nul
title 极方每周反馈程序(Web版) - Nuitka 机器码编译中心

cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo 【错误】未在系统环境变量 PATH 中检测到 Python！
    echo 请确认已安装 Python 3.10+ 并勾选 Add to PATH。
    pause
    exit /b 1
)

python "%~dp0build_nuitka.py" %*
if errorlevel 1 (
    echo.
    echo 【错误】Nuitka 编译执行失败！请查看上方报错信息。
    pause
    exit /b 1
)

echo %* | findstr /i "nopause" >nul
if errorlevel 1 pause
exit /b 0
