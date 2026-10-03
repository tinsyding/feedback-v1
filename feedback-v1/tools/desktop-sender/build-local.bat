@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 极方每周反馈程序 - Windows 本地一键打包工具

REM 始终以脚本所在目录为工作目录
cd /d "%~dp0"

echo =======================================================
echo    极方每周反馈程序 (Python 经典版) 本地一键构建脚本
echo =======================================================
echo.

REM 1. 检查 Python 环境
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未在系统 PATH 中检测到 Python，请先安装 Python 3.10+ 并勾选 "Add to PATH"。
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version') do set "PY_VER=%%i"
echo [1/4] 检测到环境: !PY_VER!

REM 2. 检查编译依赖是否齐备（PyInstaller 与离线 OCR 缺任一才安装，避免每次联网）
set "NEED_INSTALL=0"
python -m PyInstaller --version >nul 2>nul
if errorlevel 1 set "NEED_INSTALL=1"
python -c "import rapidocr_onnxruntime" >nul 2>nul
if errorlevel 1 set "NEED_INSTALL=1"

if "!NEED_INSTALL!"=="1" (
    echo [2/4] 编译依赖不完整，正在安装 requirements.txt ...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络连接后重试。
        pause
        exit /b 1
    )
) else (
    echo [2/4] 编译依赖与 PyInstaller 检测正常。
)

REM 3. 执行 PyInstaller 打包
echo [3/4] 正在启动 PyInstaller 编译构建 (预计耗时 30 ~ 90 秒)...
python -m PyInstaller --noconfirm --clean send_feedback.spec

if errorlevel 1 (
    echo.
    echo [错误] 编译构建过程中断，请检查上方控制台报错。
    echo.
    pause
    exit /b 1
)

REM 4. 验证构建产物
set "EXE_PATH=dist\JiFang-Feedback-Classic-win-x64.exe"
if exist "!EXE_PATH!" (
    copy /y "!EXE_PATH!" "dist\极方每周反馈程序.exe" >nul 2>nul
    echo.
    echo =======================================================
    echo    🎉 本地编译成功！
    echo    发布名产物: !EXE_PATH!
    echo    友好名产物: dist\极方每周反馈程序.exe
    echo =======================================================
    echo.
    echo 正在自动为您打开输出文件夹并定位文件...
    explorer /select,"!EXE_PATH!"
) else (
    echo [警告] 未在期望路径找到生成产物: !EXE_PATH!
)

echo.
echo 构建流程完成。按任意键退出窗口...
pause >nul
