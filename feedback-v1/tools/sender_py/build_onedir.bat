@echo off
chcp 65001 >nul
title 极方每周反馈程序 - 文件夹模式打包工具 (防360误报)

echo ========================================================
echo        极方每周反馈程序 - 文件夹模式 (--onedir) 打包
echo ========================================================
echo.
echo 文件夹模式说明：
echo   此模式不会在运行时将文件解压到 AppData\Local\Temp 临时目录，
echo   能够大幅避开 360/火绒/Windows Defender 的启发式木马拦截。
echo   打包完成后会生成包含完整依赖的文件夹及对应 ZIP 压缩包，
echo   解压到任意目录后双击 exe 即可直接运行。
echo.

cd /d "%~dp0"
set REPO_ROOT=%~dp0..\..
set FAVICON=%REPO_ROOT%\favicon.ico
set EXAMPLE=%REPO_ROOT%\tools\example.png
set VERSION_FILE=%~dp0version_info.txt
set SENDER_PY=%~dp0sender.py
set WEB_MAIN_PY=%~dp0web_main.py
set WEB_UI=%~dp0web_ui.html

echo [1/4] 检查 Python 环境及依赖...
python --version >nul 2>&1
if errorlevel 1 (
    echo 【错误】未检测到 Python，请先安装 Python 3.10+ 并勾选 Add to PATH。
    pause
    exit /b 1
)

echo 安装/更新 PyInstaller 及项目运行依赖...
python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
python -m pip install pyinstaller

echo.
echo [2/4] 正在打包【Tkinter 桌面版】(文件夹模式)...
if not exist "%~dp0dist_dir" mkdir "%~dp0dist_dir"
python -m PyInstaller --noconfirm --clean --noupx --windowed --onedir ^
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
python -m PyInstaller --noconfirm --clean --noupx --windowed --onedir ^
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
