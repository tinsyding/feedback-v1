@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 极方每周反馈程序 (Rust Fluent 版) - 本地一键构建

REM 始终以脚本所在目录为工作目录，双击 / 从其他目录 call 均可靠
cd /d "%~dp0"

echo =======================================================
echo    极方每周反馈程序 (Rust Fluent 版) 本地一键构建脚本
echo =======================================================
echo.

REM 1. 检查 Rust / Cargo 工具链
where cargo >nul 2>nul
if errorlevel 1 (
    echo [提示] 当前 Windows 系统中尚未安装 Rust 工具链。
    echo.
    echo Rust Fluent 版基于 Rust + Tauri 2.0 Webview 构建为原生单文件程序。
    echo 安装官方 Rustup 约 2 分钟即可本地编译：
    echo   1. 下载: https://win.rustup.rs
    echo   2. 运行 rustup-init.exe，按 Enter 选择默认安装 (x86_64-pc-windows-msvc)
    echo   3. 重启控制台后再运行本脚本
    echo.
    set /p OPEN_URL="是否现在打开 Rustup 官方下载页面？(Y/N): "
    if /i "!OPEN_URL!"=="Y" start https://win.rustup.rs
    pause
    exit /b 0
)

for /f "tokens=*" %%i in ('cargo --version') do set "CARGO_VER=%%i"
echo [1/4] 检测到 Rust 环境: !CARGO_VER!

REM 2. 识别本机默认目标平台（与云端一致的 msvc 优先，GNU 工具链自动兼容）
set "HOST="
for /f "tokens=2" %%h in ('rustc -vV ^| findstr /b "host:"') do set "HOST=%%h"
echo [2/4] 本机默认目标平台: !HOST!

if "!HOST!"=="x86_64-pc-windows-msvc" (
    set "BUILD_TARGET=x86_64-pc-windows-msvc"
    set "RAW_EXE=target\x86_64-pc-windows-msvc\release\desktop-sender-rs.exe"
    set "CARGO_ARGS=--release --target x86_64-pc-windows-msvc"
) else (
    REM 非 MSVC 默认工具链（如 GNU）：直接按本机默认编译，避免缺少 MSVC 链接器报错
    set "BUILD_TARGET=!HOST!"
    set "RAW_EXE=target\release\desktop-sender-rs.exe"
    set "CARGO_ARGS=--release"
)

REM 3. 执行 Cargo Release 编译
echo [3/4] 正在启动 Cargo 原生单文件编译构建 (Release 优化模式，首次较慢)...
cargo build !CARGO_ARGS!

if errorlevel 1 (
    echo.
    echo [错误] Cargo 编译过程中断，请检查上方控制台报错。
    echo.
    pause
    exit /b 1
)

REM 4. 整理并输出二进制产物（落到与云端一致的共享 dist 目录）
set "OUTDIR=..\desktop-sender\dist"
set "CLOUD_EXE=%OUTDIR%\JiFang-Feedback-Fluent-win-x64.exe"
set "FRIENDLY_EXE=%OUTDIR%\极方每周反馈程序-Fluent-x64.exe"

if not exist "%OUTDIR%" mkdir "%OUTDIR%"

if exist "!RAW_EXE!" (
    copy /y "!RAW_EXE!" "!CLOUD_EXE!" >nul
    copy /y "!RAW_EXE!" "!FRIENDLY_EXE!" >nul
    echo.
    echo =======================================================
    echo    🎉 本地编译成功！
    echo    编译目标: !BUILD_TARGET!
    echo    发布名产物: !CLOUD_EXE!
    echo    友好名产物: !FRIENDLY_EXE!
    echo =======================================================
    echo.
    echo 正在自动为您打开输出文件夹...
    explorer "!OUTDIR!"
) else (
    echo [警告] 未在期望路径找到生成产物: !RAW_EXE!
)

echo.
echo 构建流程完成。按任意键退出窗口...
pause >nul
