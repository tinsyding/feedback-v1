@echo off
chcp 65001 >nul
title 极方每周反馈程序 (Rust Fluent 版) - 本地一键构建

echo =======================================================
echo    极方每周反馈程序 (Rust Fluent 版) 本地一键构建脚本
echo =======================================================
echo.

REM 1. 检查 Rust / Cargo 工具链
where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo [提示] 当前 Windows 系统中尚未安装 Rust 工具链。
    echo.
    echo Rust Fluent 版是基于 Rust + Tauri 2.0 Webview 构建的原生单文件程序。
    echo 如需在本地编译，只需安装官方 Rustup（耗时约 2 分钟）：
    echo   1. 访问官网下载: https://win.rustup.rs
    echo   2. 运行 rustup-init.exe，按 Enter 选择默认安装（x86_64-pc-windows-msvc）
    echo   3. 重启控制台即可编译
    echo.
    echo 提示: 若不想在本地安装 Rust，您也可以直接使用 GitHub Actions 云端构建好的 exe。
    echo.
    set /p OPEN_URL="是否现在打开 Rustup 官方下载页面？(Y/N): "
    if /i "%OPEN_URL%"=="Y" (
        start https://win.rustup.rs
    )
    pause
    exit /b 0
)

for /f "tokens=*" %%i in ('cargo --version') do set CARGO_VER=%%i
echo [1/3] 检测到 Rust 环境: %CARGO_VER%

REM 2. 执行 Cargo Release 编译
echo [2/3] 正在启动 Cargo 原生单文件编译构建 (Release 优化模式)...
cargo build --release

if %errorlevel% neq 0 (
    echo.
    echo [错误] Cargo 编译过程中断，请检查上方控制台报错。
    echo.
    pause
    exit /b 1
)

REM 3. 整理并输出二进制产物
set RAW_EXE=target\release\desktop-sender-rs.exe
set FINAL_EXE=target\release\极方每周反馈程序-Fluent-x64.exe

if exist "%RAW_EXE%" (
    copy /y "%RAW_EXE%" "%FINAL_EXE%" >nul
    echo.
    echo =======================================================
    echo    🎉 本地编译成功！
    echo    原生单文件产物: %FINAL_EXE%
    echo =======================================================
    echo.
    echo 正在自动为您打开输出文件夹...
    explorer target\release
) else (
    echo [警告] 未在期望路径找到生成产物: %RAW_EXE%
)

echo.
echo 构建流程完成。按任意键退出窗口...
pause >nul
