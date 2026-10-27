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
set "PYTHONPATH=%REPO_ROOT%\tools;%~dp0;%PYTHONPATH%"
set "PY_CMD=py -3.12"

echo [1/3] 检查 Python 3.12 环境及依赖...
%PY_CMD% --version >nul 2>&1
if errorlevel 1 goto :no_python

echo 当前使用的 Python 版本：
%PY_CMD% --version

%PY_CMD% -m pip install --upgrade pip
%PY_CMD% -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto :pip_error
%PY_CMD% -m pip install pyinstaller

echo.
echo [2/3] 正在打包【Tkinter 桌面版】(单文件 exe)...
%PY_CMD% -m PyInstaller --noconfirm --clean --noupx --windowed --onefile ^
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
%PY_CMD% -m PyInstaller --noconfirm --clean --noupx --windowed --onefile ^
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
