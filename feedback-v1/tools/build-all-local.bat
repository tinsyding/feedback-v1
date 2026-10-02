@echo off
chcp 65001 >nul
title 极方每周反馈程序 - 本地一键构建中心

:MENU
cls
echo =======================================================
echo        极方每周反馈程序 - 本地构建控制台
echo =======================================================
echo.
echo   [1] 编译 Python 经典稳定版 (本地依赖已齐备，约 30 秒)
echo   [2] 编译 Rust Fluent 现代版 (需安装 Rust 工具链)
echo   [3] 查看云端 GitHub Releases 下载页面
echo   [4] 退出
echo.
echo =======================================================
set /p CHOICE="请选择操作编号 [1-4]: "

if "%CHOICE%"=="1" (
    cd desktop-sender
    call build-local.bat
    cd ..
    goto MENU
)
if "%CHOICE%"=="2" (
    cd desktop-sender-rs
    call build-local.bat
    cd ..
    goto MENU
)
if "%CHOICE%"=="3" (
    start https://github.com/tinsyding/feedback-v1/releases
    goto MENU
)
if "%CHOICE%"=="4" (
    exit /b 0
)

echo.
echo 输入有误，请重新输入。
timeout /t 2 >nul
goto MENU
