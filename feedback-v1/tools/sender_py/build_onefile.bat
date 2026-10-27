@echo off
chcp 65001 >nul
title 极方每周反馈程序 - 单文件打包工具 (--onefile)

echo ========================================================
echo        极方每周反馈程序 - 单文件模式 (--onefile) 打包
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

echo [1/3] 检查 Python 环境及依赖...
python --version >nul 2>&1
if errorlevel 1 (
    echo 【错误】未检测到 Python，请先安装 Python 3.10+ 并勾选 Add to PATH。
    pause
    exit /b 1
)

python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
python -m pip install pyinstaller

echo.
echo [2/3] 正在打包【Tkinter 桌面版】(单文件 exe)...
python -m PyInstaller --noconfirm --clean --noupx --windowed --onefile ^
    --name "JiFangFeedbackSender" ^
    --icon "%FAVICON%" ^
    --version-file "%VERSION_FILE%" ^
    --add-data "%FAVICON%;." ^
    --add-data "%EXAMPLE%;." ^
    --paths "%REPO_ROOT%\tools" ^
    --paths "%~dp0" ^
    --collect-submodules sender_py ^
    --collect-all sv_ttk ^
    "%SENDER_PY%"

if exist "%~dp0dist\JiFangFeedbackSender.exe" (
    copy /y "%~dp0dist\JiFangFeedbackSender.exe" "%~dp0dist\极方每周反馈程序.exe" >nul
)

echo.
echo [3/3] 正在打包【WebUI 浏览器版】(单文件 exe)...
python -m PyInstaller --noconfirm --clean --noupx --windowed --onefile ^
    --name "JiFangFeedbackWeb" ^
    --icon "%FAVICON%" ^
    --version-file "%VERSION_FILE%" ^
    --add-data "%FAVICON%;." ^
    --add-data "%EXAMPLE%;." ^
    --add-data "%WEB_UI%;sender_py" ^
    --paths "%REPO_ROOT%\tools" ^
    --paths "%~dp0" ^
    --collect-submodules sender_py ^
    "%WEB_MAIN_PY%"

if exist "%~dp0dist\JiFangFeedbackWeb.exe" (
    copy /y "%~dp0dist\JiFangFeedbackWeb.exe" "%~dp0dist\极方每周反馈程序-Web版.exe" >nul
)

echo.
echo ========================================================
echo                  ★ 打包完成！ ★
echo ========================================================
echo.
echo 输出单文件位于：
echo   - %~dp0dist\极方每周反馈程序.exe
echo   - %~dp0dist\极方每周反馈程序-Web版.exe
echo.
pause
