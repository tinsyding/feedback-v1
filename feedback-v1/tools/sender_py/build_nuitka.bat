@echo off
chcp 65001 >nul
title 极方每周反馈程序 - Nuitka 原生机器码编译中心

cd /d "%~dp0"
set REPO_ROOT=%~dp0..\..
set FAVICON=%REPO_ROOT%\favicon.ico
set EXAMPLE=%REPO_ROOT%\tools\example.png
set SENDER_PY=%~dp0sender.py
set WEB_MAIN_PY=%~dp0web_main.py
set WEB_UI=%~dp0web_ui.html
set "PYTHONPATH=%~dp0..;%~dp0;%PYTHONPATH%"

echo ========================================================
echo        极方每周反馈程序 - Nuitka 原生机器码编译
echo ========================================================
echo.

echo [环境检查] 检查 Python 环境及 Nuitka...
python --version >nul 2>&1
if errorlevel 1 goto :no_python

echo 当前使用的 Python 版本：
python --version

echo 安装/更新 Nuitka 与运行依赖...
python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto :pip_error

python -m pip install nuitka zstandard
if errorlevel 1 goto :nuitka_install_error

rem 优先根据命令行参数选择编译模式 (all / onefile / standalone / folder)
if /i "%~1"=="all" goto :run_all
if /i "%~1"=="onefile" goto :run_onefile
if /i "%~1"=="standalone" goto :run_standalone
if /i "%~1"=="folder" goto :run_standalone

:menu
echo.
echo --------------------------------------------------------
echo 请选择编译模式：
echo   [1] 全量打包：2 个单文件版本 + 2 个文件夹版本 (含 ZIP) 【推荐】
echo   [2] 仅打包 2 个单文件版本 (--onefile 独立 exe)
echo   [3] 仅打包 2 个文件夹版本 (--standalone 绿色目录 + ZIP)
echo   [0] 退出
echo --------------------------------------------------------
set "BUILD_CHOICE="
set /p BUILD_CHOICE=请输入选项编号 (0-3，直接回车默认 1): 
if "%BUILD_CHOICE%"=="" set BUILD_CHOICE=1
if "%BUILD_CHOICE%"=="1" goto :run_all
if "%BUILD_CHOICE%"=="2" goto :run_onefile
if "%BUILD_CHOICE%"=="3" goto :run_standalone
if "%BUILD_CHOICE%"=="0" exit /b 0
echo 输入无效，请重新选择。
goto :menu

:run_all
set DO_STANDALONE=1
set DO_ONEFILE=1
goto :start_build

:run_onefile
set DO_STANDALONE=0
set DO_ONEFILE=1
goto :start_build

:run_standalone
set DO_STANDALONE=1
set DO_ONEFILE=0
goto :start_build

:start_build
rem ========================================================
rem 模式一：文件夹版本 (--standalone)
rem ========================================================
if not "%DO_STANDALONE%"=="1" goto :skip_standalone

echo.
echo ========================================================
echo 正在编译【文件夹模式 (--standalone)】...
echo ========================================================

echo.
echo [1/3] 正在使用 Nuitka 编译【WebUI 浏览器版】(C++ 目录版)...
set "OPTS_WEB_DIR=--standalone --assume-yes-for-downloads --windows-console-mode=disable"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --windows-icon-from-ico=%FAVICON%"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --windows-company-name=JiFang"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --windows-product-name=JiFangFeedbackWeb"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --windows-file-version=1.8.22.0"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --windows-product-version=1.8.22.0"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --enable-plugin=tk-inter"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --include-package=sender_py"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --include-package-data=rapidocr_onnxruntime"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --include-data-files=%FAVICON%=favicon.ico"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --include-data-files=%EXAMPLE%=example.png"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --include-data-files=%WEB_UI%=sender_py/web_ui.html"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --output-dir=%~dp0dist_nuitka_web"
set "OPTS_WEB_DIR=%OPTS_WEB_DIR% --output-filename=JiFangFeedbackWeb.exe"

python -m nuitka %OPTS_WEB_DIR% "%WEB_MAIN_PY%"
if errorlevel 1 goto :compile_web_dir_error

if exist "%~dp0dist_nuitka_web\web_main.dist\JiFangFeedbackWeb.exe" (
    ren "%~dp0dist_nuitka_web\web_main.dist\JiFangFeedbackWeb.exe" "极方每周反馈程序-Web版.exe"
)
if exist "%~dp0dist_nuitka_web\web_main.dist" (
    if exist "%~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版" (
        rd /s /q "%~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版"
    )
    ren "%~dp0dist_nuitka_web\web_main.dist" "极方每周反馈程序-Web版-Nuitka原生版"
)

echo.
echo [2/3] 正在使用 Nuitka 编译【Tkinter 桌面版】(C++ 目录版)...
set "OPTS_GUI_DIR=--standalone --assume-yes-for-downloads --windows-console-mode=disable"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --windows-icon-from-ico=%FAVICON%"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --windows-company-name=JiFang"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --windows-product-name=JiFangFeedbackSender"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --windows-file-version=1.8.22.0"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --windows-product-version=1.8.22.0"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --enable-plugin=tk-inter"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --include-package-data=sv_ttk"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --include-package-data=rapidocr_onnxruntime"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --include-package=sender_py"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --include-data-files=%FAVICON%=favicon.ico"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --include-data-files=%EXAMPLE%=example.png"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --output-dir=%~dp0dist_nuitka"
set "OPTS_GUI_DIR=%OPTS_GUI_DIR% --output-filename=JiFangFeedbackSender.exe"

python -m nuitka %OPTS_GUI_DIR% "%SENDER_PY%"
if errorlevel 1 goto :compile_gui_dir_error

if exist "%~dp0dist_nuitka\sender.dist\JiFangFeedbackSender.exe" (
    ren "%~dp0dist_nuitka\sender.dist\JiFangFeedbackSender.exe" "极方每周反馈程序.exe"
)
if exist "%~dp0dist_nuitka\sender.dist" (
    if exist "%~dp0dist_nuitka\极方每周反馈程序-Nuitka原生版" (
        rd /s /q "%~dp0dist_nuitka\极方每周反馈程序-Nuitka原生版"
    )
    ren "%~dp0dist_nuitka\sender.dist" "极方每周反馈程序-Nuitka原生版"
)

echo.
echo [3/3] 正在打包压缩文件夹为 ZIP 分发包...
if not exist "%~dp0dist_zip" mkdir "%~dp0dist_zip"
powershell -NoProfile -Command "Compress-Archive -Path '%~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版' -DestinationPath '%~dp0dist_zip\极方每周反馈程序-Web版-Nuitka原生版.zip' -Force"
powershell -NoProfile -Command "Compress-Archive -Path '%~dp0dist_nuitka\极方每周反馈程序-Nuitka原生版' -DestinationPath '%~dp0dist_zip\极方每周反馈程序-Nuitka原生版.zip' -Force"

:skip_standalone

rem ========================================================
rem 模式二：单文件版本 (--onefile)
rem ========================================================
if not "%DO_ONEFILE%"=="1" goto :skip_onefile

echo.
echo ========================================================
echo 正在编译【单文件模式 (--onefile)】...
echo ========================================================
if not exist "%~dp0dist_nuitka_onefile" mkdir "%~dp0dist_nuitka_onefile"

echo.
echo [1/2] 正在使用 Nuitka 编译【WebUI 浏览器版】(单文件 exe)...
set "OPTS_WEB_ONE=--onefile --assume-yes-for-downloads --windows-console-mode=disable"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --windows-icon-from-ico=%FAVICON%"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --windows-company-name=JiFang"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --windows-product-name=JiFangFeedbackWeb"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --windows-file-version=1.8.22.0"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --windows-product-version=1.8.22.0"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --enable-plugin=tk-inter"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --include-package=sender_py"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --include-package-data=rapidocr_onnxruntime"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --include-data-files=%FAVICON%=favicon.ico"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --include-data-files=%EXAMPLE%=example.png"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --include-data-files=%WEB_UI%=sender_py/web_ui.html"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --output-dir=%~dp0dist_nuitka_onefile"
set "OPTS_WEB_ONE=%OPTS_WEB_ONE% --output-filename=JiFangFeedbackWeb.exe"

python -m nuitka %OPTS_WEB_ONE% "%WEB_MAIN_PY%"
if errorlevel 1 goto :compile_web_one_error

if exist "%~dp0dist_nuitka_onefile\JiFangFeedbackWeb.exe" (
    copy /y "%~dp0dist_nuitka_onefile\JiFangFeedbackWeb.exe" "%~dp0dist_nuitka_onefile\极方每周反馈程序-Web版.exe" >nul
)

echo.
echo [2/2] 正在使用 Nuitka 编译【Tkinter 桌面版】(单文件 exe)...
set "OPTS_GUI_ONE=--onefile --assume-yes-for-downloads --windows-console-mode=disable"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --windows-icon-from-ico=%FAVICON%"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --windows-company-name=JiFang"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --windows-product-name=JiFangFeedbackSender"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --windows-file-version=1.8.22.0"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --windows-product-version=1.8.22.0"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --enable-plugin=tk-inter"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --include-package-data=sv_ttk"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --include-package-data=rapidocr_onnxruntime"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --include-package=sender_py"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --include-data-files=%FAVICON%=favicon.ico"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --include-data-files=%EXAMPLE%=example.png"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --output-dir=%~dp0dist_nuitka_onefile"
set "OPTS_GUI_ONE=%OPTS_GUI_ONE% --output-filename=JiFangFeedbackSender.exe"

python -m nuitka %OPTS_GUI_ONE% "%SENDER_PY%"
if errorlevel 1 goto :compile_gui_one_error

if exist "%~dp0dist_nuitka_onefile\JiFangFeedbackSender.exe" (
    copy /y "%~dp0dist_nuitka_onefile\JiFangFeedbackSender.exe" "%~dp0dist_nuitka_onefile\极方每周反馈程序.exe" >nul
)

:skip_onefile

echo.
echo ========================================================
echo            ★ Nuitka 原生机器码编译完成！ ★
echo ========================================================
echo.
if "%DO_ONEFILE%"=="1" (
    echo 【单文件独立 EXE 版本】（2 个）：
    echo   - %~dp0dist_nuitka_onefile\极方每周反馈程序.exe
    echo   - %~dp0dist_nuitka_onefile\极方每周反馈程序-Web版.exe
    echo.
)
if "%DO_STANDALONE%"=="1" (
    echo 【绿色解压文件夹版本】（2 个）：
    echo   - %~dp0dist_nuitka\极方每周反馈程序-Nuitka原生版\
    echo   - %~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版\
    echo.
    echo 【对应 ZIP 压缩包】：
    echo   - %~dp0dist_zip\极方每周反馈程序-Nuitka原生版.zip
    echo   - %~dp0dist_zip\极方每周反馈程序-Web版-Nuitka原生版.zip
    echo.
)
echo 该版本为原生 C++ 编译机器码，无 Python 运行时特征，彻底免疫杀软误报！
pause
exit /b 0

:no_python
echo.
echo 【错误】未检测到 Python！
echo 请确认已安装 Python 3.10+ 并勾选 Add to PATH。
pause
exit /b 1

:pip_error
echo.
echo 【错误】依赖安装失败！请检查网络后重试。
pause
exit /b 1

:nuitka_install_error
echo.
echo 【错误】Nuitka 或 zstandard 安装失败！
pause
exit /b 1

:compile_web_dir_error
echo.
echo 【错误】WebUI 版 Nuitka 文件夹模式编译失败！
pause
exit /b 1

:compile_gui_dir_error
echo.
echo 【错误】Tkinter 桌面版 Nuitka 文件夹模式编译失败！
pause
exit /b 1

:compile_web_one_error
echo.
echo 【错误】WebUI 版 Nuitka 单文件模式编译失败！
pause
exit /b 1

:compile_gui_one_error
echo.
echo 【错误】Tkinter 桌面版 Nuitka 单文件模式编译失败！
pause
exit /b 1
