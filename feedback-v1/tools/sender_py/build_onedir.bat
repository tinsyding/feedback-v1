@echo off
chcp 65001 >nul
title 极方每周反馈程序 - 文件夹模式打包工具 (防360误报)

echo ========================================================
echo        极方每周反馈程序 - 文件夹模式 (--onedir) 打包
echo ========================================================
echo.

cd /d "%~dp0"
set REPO_ROOT=%~dp0..\..
set FAVICON=%REPO_ROOT%\favicon.ico
set EXAMPLE=%REPO_ROOT%\tools\example.png
set VERSION_FILE=%~dp0version_info.txt
set SENDER_PY=%~dp0sender.py
set WEB_MAIN_PY=%~dp0web_main.py
set WEB_UI=%~dp0web_ui.html
set "PYTHONPATH=%REPO_ROOT%\tools;%~dp0;%PYTHONPATH%"
set "PY_CMD=py -3.12"

echo [1/4] 检查 Python 3.12 环境及依赖...
%PY_CMD% --version >nul 2>&1
if errorlevel 1 goto :no_python

echo 当前使用的 Python 版本：
%PY_CMD% --version

echo 安装/更新 PyInstaller 及项目运行依赖...
%PY_CMD% -m pip install --upgrade pip
%PY_CMD% -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto :pip_error
%PY_CMD% -m pip install pyinstaller

echo.
echo [2/4] 正在打包【Tkinter 桌面版】(文件夹模式)...
if not exist "%~dp0dist_dir" mkdir "%~dp0dist_dir"
%PY_CMD% -m PyInstaller --noconfirm --clean --noupx --windowed --onedir ^
    --distpath "%~dp0dist_dir" ^
    --name "JiFangFeedbackSender" ^
    --icon "%FAVICON%" ^
    --version-file "%VERSION_FILE%" ^
    --add-data "%FAVICON%;." ^
    --add-data "%EXAMPLE%;." ^
    --paths "%REPO_ROOT%\tools" ^
    --paths "%~dp0" ^
    --collect-submodules sender_py ^
    --collect-all sv_ttk ^
    --collect-all rapidocr_onnxruntime ^
    "%SENDER_PY%"

if exist "%~dp0dist_dir\JiFangFeedbackSender\JiFangFeedbackSender.exe" (
    ren "%~dp0dist_dir\JiFangFeedbackSender\JiFangFeedbackSender.exe" "极方每周反馈程序.exe"
)
if exist "%~dp0dist_dir\极方每周反馈程序-绿色文件夹版" (
    rd /s /q "%~dp0dist_dir\极方每周反馈程序-绿色文件夹版"
)
ren "%~dp0dist_dir\JiFangFeedbackSender" "极方每周反馈程序-绿色文件夹版"

echo.
echo [3/4] 正在打包【WebUI 浏览器版】(文件夹模式)...
%PY_CMD% -m PyInstaller --noconfirm --clean --noupx --windowed --onedir ^
    --distpath "%~dp0dist_dir" ^
    --name "JiFangFeedbackWeb" ^
    --icon "%FAVICON%" ^
    --version-file "%VERSION_FILE%" ^
    --add-data "%FAVICON%;." ^
    --add-data "%EXAMPLE%;." ^
    --add-data "%WEB_UI%;sender_py" ^
    --paths "%REPO_ROOT%\tools" ^
    --paths "%~dp0" ^
    --collect-submodules sender_py ^
    --collect-all rapidocr_onnxruntime ^
    "%WEB_MAIN_PY%"

if exist "%~dp0dist_dir\JiFangFeedbackWeb\JiFangFeedbackWeb.exe" (
    ren "%~dp0dist_dir\JiFangFeedbackWeb\JiFangFeedbackWeb.exe" "极方每周反馈程序-Web版.exe"
)
if exist "%~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版" (
    rd /s /q "%~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版"
)
ren "%~dp0dist_dir\JiFangFeedbackWeb" "极方每周反馈程序-Web版-绿色文件夹版"

echo.
echo [4/4] 正在自动压缩生成 ZIP 分发包...
if not exist "%~dp0dist_zip" mkdir "%~dp0dist_zip"
powershell -NoProfile -Command "Compress-Archive -Path '%~dp0dist_dir\极方每周反馈程序-绿色文件夹版' -DestinationPath '%~dp0dist_zip\极方每周反馈程序-绿色文件夹版.zip' -Force"
powershell -NoProfile -Command "Compress-Archive -Path '%~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版' -DestinationPath '%~dp0dist_zip\极方每周反馈程序-Web版-绿色文件夹版.zip' -Force"

echo.
echo ========================================================
echo                  ★ 打包完成！ ★
echo ========================================================
echo.
echo 生成的免报毒绿色文件夹目录位于：
echo   - %~dp0dist_dir\极方每周反馈程序-绿色文件夹版\
echo   - %~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版\
echo.
echo 生成的 ZIP 压缩分发包位于：
echo   - %~dp0dist_zip\极方每周反馈程序-绿色文件夹版.zip
echo   - %~dp0dist_zip\极方每周反馈程序-Web版-绿色文件夹版.zip
echo.
echo 分发建议：直接把 ZIP 压缩包发给老师，解压后双击内部 exe 运行即可！
pause
exit /b 0

:no_python
echo.
echo 【错误】未检测到 Python 3.12！
echo 请确认已安装 Python 3.12 且 py.exe 启动器可用。
pause
exit /b 1

:pip_error
echo.
echo 【错误】依赖安装失败！请检查网络后重试。
pause
exit /b 1
