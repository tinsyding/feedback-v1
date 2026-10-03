@echo off
chcp 65001 >nul
title 极方每周反馈程序 - Windows 本地一键打包工具

echo =======================================================
echo    极方每周反馈程序 (Python 经典版) 本地一键构建脚本
echo =======================================================
echo.

REM 1. 检查 Python 环境
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未在系统 PATH 中检测到 Python，请先安装 Python 3.10+ 并勾选 "Add to PATH"。
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version') do set PY_VER=%%i
echo [1/4] 检测到环境: %PY_VER%

REM 2. 检查并安装 PyInstaller 与依赖项
python -m PyInstaller --version >nul 2>nul
if %errorlevel% neq 0 (
    echo [2/4] 未检测到 PyInstaller，正在自动安装编译依赖...
    python -m pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请检查网络连接后重试。
        pause
        exit /b 1
    )
) else (
    echo [2/4] 编译依赖与 PyInstaller 检测正常。
)

REM 3. 执行 PyInstaller 打包
echo [3/4] 正在启动 PyInstaller 编译构建 (预计耗时 30 ~ 60 秒)...
python -m PyInstaller --noconfirm --clean send_feedback.spec

if %errorlevel% neq 0 (
    echo.
    echo [错误] 编译构建过程中断，请检查上方控制台报错。
    echo.
    pause
    exit /b 1
)

REM 4. 验证构建产物
set EXE_PATH=dist\极方每周反馈程序.exe
if exist "%EXE_PATH%" (
    echo.
    echo =======================================================
    echo    🎉 本地编译成功！
    echo    单文件 EXE 产物: %EXE_PATH%
    echo =======================================================
    echo.
    echo 正在自动为您打开输出文件夹并定位文件...
    explorer /select,"%EXE_PATH%"
) else (
    echo [警告] 未在期望路径找到生成产物: %EXE_PATH%
)

echo.
echo 构建流程完成。按任意键退出窗口...
pause >nul
