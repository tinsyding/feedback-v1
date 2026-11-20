@echo off
chcp 65001 >nul
title 极方每周反馈程序(Web版) - 单文件打包工具 (--onefile)

echo ========================================================
echo     极方每周反馈程序 - Web版单文件模式 (--onefile) 打包
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
set XLSX_JS=%REPO_ROOT%\js\libs\xlsx.full.min.js
set "PYTHONPATH=%REPO_ROOT%\tools;%~dp0;%PYTHONPATH%"

echo [1/2] 检查 Python 环境及依赖...
python --version >nul 2>&1
if errorlevel 1 goto :no_python

echo 当前使用的 Python 版本：
python --version

python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto :pip_error
python -m pip install pyinstaller

rem 确保生成 16~256px 多尺寸高清 ICO，保证任务栏与标题栏高清显示公司 Logo
python -c "from PIL import Image; im=Image.open(r'%FAVICON%'); img=im.copy(); im.close(); img.save(r'%FAVICON%', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])" >nul 2>&1

echo.
echo [2/2] 正在打包【极方每周反馈程序 Web版】(单文件 exe)...
python -m PyInstaller --noconfirm --clean --noupx --windowed --onefile ^
    --name "JiFangFeedbackWeb" ^
    --icon "%FAVICON%" ^
    --version-file "%VERSION_FILE%" ^
    --add-data "%FAVICON%;." ^
    --add-data "%FAVICON%;sender_py" ^
    --add-data "%EXAMPLE%;." ^
    --add-data "%EXAMPLE%;sender_py" ^
    --add-data "%WEB_UI%;sender_py" ^
    --add-data "%WEB_UI%;." ^
    --add-data "%XLSX_JS%;sender_py" ^
    --add-data "%XLSX_JS%;." ^
    --paths "%REPO_ROOT%\tools" ^
    --paths "%~dp0" ^
    --collect-submodules sender_py ^
    --exclude-module sender_py.tests ^
    --exclude-module unittest ^
    --exclude-module test ^
    --hidden-import sender_py.sender_token ^
    --hidden-import winocr ^
    --collect-all rapidocr_onnxruntime ^
    --collect-all winrt ^
    "%WEB_MAIN_PY%"

if exist "%~dp0dist\JiFangFeedbackWeb.exe" (
    if exist "%~dp0dist\极方每周反馈程序-Web版.exe" del /f /q "%~dp0dist\极方每周反馈程序-Web版.exe"
    move /y "%~dp0dist\JiFangFeedbackWeb.exe" "%~dp0dist\极方每周反馈程序-Web版.exe" >nul
)

echo.
echo ========================================================
echo                  ★ 打包完成！ ★
echo ========================================================
echo.
echo 输出单文件位于：
echo   - %~dp0dist\极方每周反馈程序-Web版.exe
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
