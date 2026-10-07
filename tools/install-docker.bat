@echo off
title 安装 Docker Desktop
echo.
echo   ============================================================
echo     安装 Docker Desktop（一次性，约 5 分钟）
echo   ============================================================
echo.
echo   Docker 是用来跑"专业版/网络版"的：数据库、附件存储、程序
echo   各跑一个容器，数据都在本机 ./data 目录里，删容器不丢数据。
echo.
echo   如果你只是想单机用，不需要装这个 —— 直接装
echo   「弱电项目管理系统-安装程序.exe」就行。
echo.
pause

where docker >nul 2>nul
if not errorlevel 1 (
  echo   [OK] 已经装过 Docker 了。
  docker --version
  echo.
  pause
  exit /b 0
)

echo   正在用 winget 安装...
echo.
winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo   [X] 自动安装失败。请手动装：
  echo       https://www.docker.com/products/docker-desktop/
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     装好了
echo   ============================================================
echo.
echo   接下来：
echo     1. 重启电脑（必须，否则 Docker 起不来）
echo     2. 打开 Docker Desktop，等左下角图标变绿
echo     3. 回到本目录双击 start.bat
echo.
pause