@echo off
title 图文浏览器
cd /d "%~dp0"

set "NODE_CMD=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
  ) else (
    echo.
    echo   [错误] 未找到 Node.js 运行环境！
    echo.
    echo   请先安装 Node.js（下载 LTS 版本）：
    echo   https://nodejs.org/zh-cn/download
    echo.
    echo   安装完成后，重新双击本文件即可启动。
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   ====================================
echo        图文浏览器  正在启动...
echo   ====================================
echo.
echo   启动成功后会自动打开浏览器页面。
echo   如需停止服务：关闭本窗口或按 Ctrl + C。
echo.
echo   若浏览器未自动打开或端口被占用，
echo   请看下方 "访问地址" 行手动打开。
echo.

"%NODE_CMD%" server.js --open

echo.
echo   服务已停止，按任意键关闭窗口。
pause >nul
