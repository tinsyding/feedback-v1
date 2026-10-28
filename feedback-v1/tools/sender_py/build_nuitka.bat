@echo off
chcp 65001 >nul
title 极方每周反馈程序 - Nuitka 原生机器码编译 (终极免杀防报毒)

echo ========================================================
echo        极方每周反馈程序 - Nuitka 原生编译模式
echo ========================================================
echo.

cd /d "%~dp0"
set REPO_ROOT=%~dp0..\..
set FAVICON=%REPO_ROOT%\favicon.ico
set EXAMPLE=%REPO_ROOT%\tools\example.png
set SENDER_PY=%~dp0sender.py
set WEB_MAIN_PY=%~dp0web_main.py
set WEB_UI=%~dp0web_ui.html
set "PYTHONPATH=%~dp0..;%~dp0;%PYTHONPATH%"

echo [1/4] 检查 Python 环境及 Nuitka...
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

echo.
echo [2/4] 正在使用 Nuitka 编译【WebUI 浏览器版】(C++ 原生编译)...
set "OPTS_WEB=--standalone --assume-yes-for-downloads --windows-console-mode=disable"
set "OPTS_WEB=%OPTS_WEB% --windows-icon-from-ico=%FAVICON%"
set "OPTS_WEB=%OPTS_WEB% --windows-company-name=JiFang"
set "OPTS_WEB=%OPTS_WEB% --windows-product-name=JiFangFeedbackWeb"
set "OPTS_WEB=%OPTS_WEB% --windows-file-version=1.8.14.0"
set "OPTS_WEB=%OPTS_WEB% --windows-product-version=1.8.14.0"
set "OPTS_WEB=%OPTS_WEB% --enable-plugin=tk-inter"
set "OPTS_WEB=%OPTS_WEB% --include-package=sender_py"
set "OPTS_WEB=%OPTS_WEB% --include-package-data=rapidocr_onnxruntime"
set "OPTS_WEB=%OPTS_WEB% --include-data-files=%FAVICON%=favicon.ico"
set "OPTS_WEB=%OPTS_WEB% --include-data-files=%EXAMPLE%=example.png"
set "OPTS_WEB=%OPTS_WEB% --include-data-files=%WEB_UI%=sender_py/web_ui.html"
set "OPTS_WEB=%OPTS_WEB% --output-dir=%~dp0dist_nuitka_web"
set "OPTS_WEB=%OPTS_WEB% --output-filename=JiFangFeedbackWeb.exe"

python -m nuitka %OPTS_WEB% "%WEB_MAIN_PY%"
if errorlevel 1 goto :compile_web_error

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
echo [3/4] 正在使用 Nuitka 编译【Tkinter 桌面版】(C++ 原生编译)...
set "OPTS_GUI=--standalone --assume-yes-for-downloads --windows-console-mode=disable"
set "OPTS_GUI=%OPTS_GUI% --windows-icon-from-ico=%FAVICON%"
set "OPTS_GUI=%OPTS_GUI% --windows-company-name=JiFang"
set "OPTS_GUI=%OPTS_GUI% --windows-product-name=JiFangFeedbackSender"
set "OPTS_GUI=%OPTS_GUI% --windows-file-version=1.8.14.0"
set "OPTS_GUI=%OPTS_GUI% --windows-product-version=1.8.14.0"
set "OPTS_GUI=%OPTS_GUI% --enable-plugin=tk-inter"
set "OPTS_GUI=%OPTS_GUI% --include-package-data=sv_ttk"
set "OPTS_GUI=%OPTS_GUI% --include-package-data=rapidocr_onnxruntime"
set "OPTS_GUI=%OPTS_GUI% --include-package=sender_py"
set "OPTS_GUI=%OPTS_GUI% --include-data-files=%FAVICON%=favicon.ico"
set "OPTS_GUI=%OPTS_GUI% --include-data-files=%EXAMPLE%=example.png"
set "OPTS_GUI=%OPTS_GUI% --output-dir=%~dp0dist_nuitka"
set "OPTS_GUI=%OPTS_GUI% --output-filename=JiFangFeedbackSender.exe"

python -m nuitka %OPTS_GUI% "%SENDER_PY%"
if errorlevel 1 goto :compile_gui_error

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
echo [4/4] 正在打包压缩为 ZIP...
if not exist "%~dp0dist_zip" mkdir "%~dp0dist_zip"
powershell -NoProfile -Command "Compress-Archive -Path '%~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版' -DestinationPath '%~dp0dist_zip\极方每周反馈程序-Web版-Nuitka原生版.zip' -Force"
powershell -NoProfile -Command "Compress-Archive -Path '%~dp0dist_nuitka\极方每周反馈程序-Nuitka原生版' -DestinationPath '%~dp0dist_zip\极方每周反馈程序-Nuitka原生版.zip' -Force"

echo.
echo ========================================================
echo            ★ Nuitka 原生机器码编译完成！ ★
echo ========================================================
echo.
echo 编译产物目录：
echo   - %~dp0dist_nuitka\极方每周反馈程序-Nuitka原生版\
echo   - %~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版\
echo.
echo 生成的 ZIP 压缩包位于：
echo   - %~dp0dist_zip\极方每周反馈程序-Nuitka原生版.zip
echo   - %~dp0dist_zip\极方每周反馈程序-Web版-Nuitka原生版.zip
echo.
echo 该版本为原生 C++ 编译机器码，无 Python 运行时特征，几乎 100%% 免疫 360 误报！
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

:compile_web_error
echo.
echo 【错误】WebUI 版 Nuitka 编译失败！
pause
exit /b 1

:compile_gui_error
echo.
echo 【错误】Tkinter 桌面版 Nuitka 编译失败！
pause
exit /b 1
