@echo off
chcp 65001 >nul
title 极方每周反馈程序 - 打包发布综合中心

:menu
cls
echo ========================================================
echo          极方每周反馈程序 - 打包发布综合中心
echo ========================================================
echo.
echo   [1] 文件夹模式打包 (PyInstaller --onedir，防360拦截推荐)
echo   [2] Nuitka 原生机器码编译 (原生 C++ 机器码，支持单文件与文件夹)
echo   [3] 经典单文件打包 (PyInstaller --onefile，单个 exe 携带方便)
echo   [4] 一键全量打包 (依次执行上述所有模式并生成对应 ZIP)
echo   [0] 退出
echo.
set /p choice=请输入选项编号 (0-4): 

if "%choice%"=="1" goto onedir
if "%choice%"=="2" goto nuitka
if "%choice%"=="3" goto onefile
if "%choice%"=="4" goto all
if "%choice%"=="0" exit /b 0
goto menu

:onedir
call "%~dp0build_onedir.bat"
goto menu

:nuitka
call "%~dp0build_nuitka.bat"
goto menu

:onefile
call "%~dp0build_onefile.bat"
goto menu

:all
call "%~dp0build_onedir.bat"
call "%~dp0build_nuitka.bat" all
call "%~dp0build_onefile.bat"
goto menu
