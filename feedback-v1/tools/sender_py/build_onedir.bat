@echo off
chcp 65001 >nul
title 极方每周反馈程序(Web版) - 文件夹模式打包工具 (防360误报)

echo ========================================================
echo     极方每周反馈程序 - Web版文件夹模式 (--onedir) 打包
echo          (注：Tkinter桌面版已停更，以Web版为主)
echo ========================================================
echo.

cd /d "%~dp0"
set REPO_ROOT=%~dp0..\..
set FAVICON=%REPO_ROOT%\favicon.ico
set EXAMPLE=%REPO_ROOT%\tools\example.png
set VERSION_FILE=%~dp0version_info.txt
set WEB_MAIN_PY=%~dp0web_main.py
set WEB_UI=%~dp0web_ui.html
set "PYTHONPATH=%REPO_ROOT%\tools;%~dp0;%PYTHONPATH%"

echo [1/3] 检查 Python 环境及依赖...
python --version >nul 2>&1
if errorlevel 1 goto :no_python

echo 当前使用的 Python 版本：
python --version

echo 安装/更新 PyInstaller 及项目运行依赖...
python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto :pip_error
python -m pip install pyinstaller

rem 确保生成 16~256px 多尺寸高清 ICO，保证任务栏与标题栏高清显示公司 Logo
python -c "from PIL import Image; im=Image.open(r'%FAVICON%'); img=im.copy(); im.close(); img.save(r'%FAVICON%', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])" >nul 2>&1

echo.
echo [2/3] 正在打包【极方每周反馈程序 Web版】(文件夹模式)...
if not exist "%~dp0dist_dir" mkdir "%~dp0dist_dir"
if exist "%~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版" (
    rd /s /q "%~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版"
)
if exist "%~dp0dist_dir\JiFangFeedbackWeb" (
    rd /s /q "%~dp0dist_dir\JiFangFeedbackWeb"
)

python -m PyInstaller --noconfirm --clean --noupx --windowed --onedir ^
    --distpath "%~dp0dist_dir" ^
    --name "JiFangFeedbackWeb" ^
    --icon "%FAVICON%" ^
    --version-file "%VERSION_FILE%" ^
    --add-data "%FAVICON%;." ^
    --add-data "%FAVICON%;sender_py" ^
    --add-data "%EXAMPLE%;." ^
    --add-data "%EXAMPLE%;sender_py" ^
    --add-data "%WEB_UI%;sender_py" ^
    --add-data "%WEB_UI%;." ^
    --paths "%REPO_ROOT%\tools" ^
    --paths "%~dp0" ^
    --collect-submodules sender_py ^
    --exclude-module sender_py.tests ^
    --exclude-module unittest ^
    --exclude-module test ^
    --hidden-import sender_py.sender_token ^
    --collect-all rapidocr_onnxruntime ^
    --collect-all winocr ^
    --collect-all winrt ^
    "%WEB_MAIN_PY%"

if exist "%~dp0dist_dir\JiFangFeedbackWeb\JiFangFeedbackWeb.exe" (
    ren "%~dp0dist_dir\JiFangFeedbackWeb\JiFangFeedbackWeb.exe" "极方每周反馈程序-Web版.exe"
)
ren "%~dp0dist_dir\JiFangFeedbackWeb" "极方每周反馈程序-Web版-绿色文件夹版"

echo.
echo [3/3] 正在自动压缩生成 ZIP 分发包...
if not exist "%~dp0dist_zip" mkdir "%~dp0dist_zip"
if exist "%~dp0dist_zip\极方每周反馈程序-Web版-绿色文件夹版.zip" (
    del /f /q "%~dp0dist_zip\极方每周反馈程序-Web版-绿色文件夹版.zip"
)
powershell -NoProfile -Command "Compress-Archive -Path '%~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版' -DestinationPath '%~dp0dist_zip\极方每周反馈程序-Web版-绿色文件夹版.zip' -Force"

echo.
echo ========================================================
echo                  ★ 打包完成！ ★
echo ========================================================
echo.
echo 生成的免报毒绿色文件夹目录位于：
echo   - %~dp0dist_dir\极方每周反馈程序-Web版-绿色文件夹版\
echo.
echo 生成的 ZIP 压缩分发包位于：
echo   - %~dp0dist_zip\极方每周反馈程序-Web版-绿色文件夹版.zip
echo.
echo 分发建议：直接把 ZIP 压缩包发给老师，解压后双击内部 极方每周反馈程序-Web版.exe 运行即可！
echo.
echo %* | findstr /i "nopause" >nul
if errorlevel 1 pause
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
