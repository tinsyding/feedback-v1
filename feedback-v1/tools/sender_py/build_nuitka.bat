@echo off
chcp 65001 >nul
title 极方每周反馈程序 - Nuitka 原生机器码编译 (终极免杀防报毒)

echo ========================================================
echo        极方每周反馈程序 - Nuitka 原生编译模式
echo ========================================================
echo.
echo Nuitka 编译模式说明：
echo   此模式通过 Nuitka 将 Python 源代码直接翻译为 C/C++ 代码，
echo   并通过原生 C++ 编译器（MSVC/MinGW64）编译为真正的 Windows 原生机器码。
echo   不包含 PyInstaller 的 bootloader 启动特征码，杀软信任度最高，
echo   是彻底解决 360 / Windows Defender 误报的技术方案。
echo.

cd /d "%~dp0"
set REPO_ROOT=%~dp0..\..
set FAVICON=%REPO_ROOT%\favicon.ico
set EXAMPLE=%REPO_ROOT%\tools\example.png
set SENDER_PY=%~dp0sender.py
set WEB_MAIN_PY=%~dp0web_main.py
set WEB_UI=%~dp0web_ui.html

echo [1/4] 检查 Python 环境及 Nuitka...
python --version >nul 2>&1
if errorlevel 1 (
    echo 【错误】未检测到 Python，请先安装 Python 3.10+ 并勾选 Add to PATH。
    pause
    exit /b 1
)

echo 安装/更新 Nuitka 与运行依赖...
python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
python -m pip install nuitka zstandard

echo.
echo [2/4] 正在使用 Nuitka 编译【WebUI 浏览器版】(C++ 原生编译)...
python -m nuitka --standalone --assume-yes-for-downloads --windows-console-mode=disable ^
    --windows-icon-from-ico="%FAVICON%" ^
    --windows-company-name="极方教学" ^
    --windows-product-name="极方每周反馈程序-Web版" ^
    --windows-file-version="1.8.7.0" ^
    --windows-product-version="1.8.7.0" ^
    --windows-file-description="极方企业微信作业反馈发送器-Web版" ^
    --include-package=sender_py ^
    --include-data-files="%FAVICON%=favicon.ico" ^
    --include-data-files="%EXAMPLE%=example.png" ^
    --include-data-files="%WEB_UI%=sender_py/web_ui.html" ^
    --output-dir="%~dp0dist_nuitka_web" ^
    --output-filename="极方每周反馈程序-Web版.exe" ^
    "%WEB_MAIN_PY%"

if exist "%~dp0dist_nuitka_web\web_main.dist" (
    if exist "%~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版" (
        rd /s /q "%~dp0dist_nuitka_web\极方每周反馈程序-Web版-Nuitka原生版"
    )
    ren "%~dp0dist_nuitka_web\web_main.dist" "极方每周反馈程序-Web版-Nuitka原生版"
)

echo.
echo [3/4] 正在使用 Nuitka 编译【Tkinter 桌面版】(C++ 原生编译)...
python -m nuitka --standalone --assume-yes-for-downloads --windows-console-mode=disable ^
    --windows-icon-from-ico="%FAVICON%" ^
    --windows-company-name="极方教学" ^
    --windows-product-name="极方每周反馈程序" ^
    --windows-file-version="1.8.7.0" ^
    --windows-product-version="1.8.7.0" ^
    --windows-file-description="极方企业微信作业反馈发送器" ^
    --enable-plugin=tk-inter ^
    --include-package-data=sv_ttk ^
    --include-package=sender_py ^
    --include-data-files="%FAVICON%=favicon.ico" ^
    --include-data-files="%EXAMPLE%=example.png" ^
    --output-dir="%~dp0dist_nuitka" ^
    --output-filename="极方每周反馈程序.exe" ^
    "%SENDER_PY%"

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
