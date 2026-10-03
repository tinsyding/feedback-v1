@echo off
chcp 65001 >nul
title 极方每周反馈程序 (C++ & Qt 原生重构版) - 本地构建

echo =======================================================
echo    极方每周反馈程序 (C++ & Qt 原生版) 本地构建脚本
echo =======================================================
echo.

where cmake >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 当前系统未检测到 cmake。请先安装 CMake (https://cmake.org) 并加入 PATH。
    pause
    exit /b 1
)

echo [1/3] 配置 CMake 构建工程...
cmake -B build -DCMAKE_BUILD_TYPE=Release
if %errorlevel% neq 0 (
    echo [错误] CMake 配置失败，请检查是否已配置 MSVC/GCC 及 Qt6 环境变量。
    pause
    exit /b 1
)

echo.
echo [2/3] 编译可执行程序...
cmake --build build --config Release --parallel
if %errorlevel% neq 0 (
    echo [错误] 编译失败，请检查上方控制台报错。
    pause
    exit /b 1
)

echo.
echo [3/3] 运行自动化单元测试...
build\Release\run_unit_tests.exe 2>nul || build\run_unit_tests.exe
if %errorlevel% neq 0 (
    echo [警告] 单元测试执行异常，请核对日志。
)

echo.
echo =======================================================
echo    🎉 本地编译构建成功！
echo    构建产物位于: build\ 目录
echo =======================================================
pause
