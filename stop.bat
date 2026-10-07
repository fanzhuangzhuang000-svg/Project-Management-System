@echo off
title 弱电项目管理系统 - 停止
cd /d "%~dp0"

echo.
echo   正在停止服务...
docker compose down
echo.
echo   已停止。
echo.
echo   数据全部保留在 ./data 目录里，下次双击 start.bat 就回来了。
echo.
pause