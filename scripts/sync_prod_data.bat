@echo off
chcp 65001 >nul
title 从服务器拉取最新题库与错题数据
echo 正在启动 WSL 同步脚本...
echo.
wsl.exe -e bash -lc "bash \"$(wslpath -u '%~dp0sync_prod_data.sh')\""
echo.
if %ERRORLEVEL% neq 0 (
    echo [错误] 同步过程出现异常，退出码: %ERRORLEVEL%
) else (
    echo [完成] 本地数据已是最新！
)
pause
