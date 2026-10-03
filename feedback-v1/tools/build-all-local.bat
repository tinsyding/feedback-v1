@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 极方每周反馈程序 - 本地一键构建中心

cd /d "%~dp0"

:MENU
cls
echo =======================================================
echo        极方每周反馈程序 - 本地构建控制台
echo =======================================================
echo.
echo   [1] 编译 Python 经典稳定版 (约 30 ~ 90 秒)
echo   [2] 编译 Rust Fluent 现代版 (首次较慢，需 Rust 工具链)
echo   [3] 一键编译全部 (经典版 + Fluent 版)
echo   [4] 打开产物目录 desktop-sender\dist
echo   [5] 查看云端 GitHub Releases 下载页面
echo   [6] 退出
echo.
echo =======================================================
set /p CHOICE="请选择操作编号 [1-6]: "

REM 用 pushd/popd 包住每次子脚本调用：子脚本会 cd 到自身目录，popd 确保返回本目录
if "%CHOICE%"=="1" (
    pushd "%~dp0desktop-sender"
    call build-local.bat
    popd
    goto MENU
)
if "%CHOICE%"=="2" (
    pushd "%~dp0desktop-sender-rs"
    call build-local.bat
    popd
    goto MENU
)
if "%CHOICE%"=="3" (
    echo.
    echo ==== 步骤 1/2：Python 经典稳定版 ====
    pushd "%~dp0desktop-sender"
    call build-local.bat
    popd
    echo.
    echo ==== 步骤 2/2：Rust Fluent 现代版 ====
    pushd "%~dp0desktop-sender-rs"
    call build-local.bat
    popd
    goto MENU
)
if "%CHOICE%"=="4" (
    if not exist "desktop-sender\dist" mkdir "desktop-sender\dist"
    explorer "desktop-sender\dist"
    goto MENU
)
if "%CHOICE%"=="5" (
    start https://github.com/tinsyding/feedback-v1/releases
    goto MENU
)
if "%CHOICE%"=="6" (
    exit /b 0
)

echo.
echo 输入有误，请重新输入。
timeout /t 2 >nul
goto MENU
