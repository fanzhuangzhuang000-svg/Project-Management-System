@echo off
title 弱电项目管理系统 - 启动
cd /d "%~dp0"

echo.
echo   ============================================================
echo     弱电项目管理系统  专业版（网络版）
echo   ============================================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo   [X] 没找到 Docker。
  echo.
  echo       请先双击  tools\install-docker.bat  安装 Docker Desktop，
  echo       装完重启电脑，再回来双击本文件。
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo   [!] 没有 .env 文件，正在从 .env.example 生成...
  copy ".env.example" ".env" >nul
  echo.
  echo       *** 请先用记事本打开 .env，把密码改成你自己的 ***
  echo       *** 改完再双击本文件                          ***
  echo.
  notepad ".env"
  pause
  exit /b 1
)

echo   正在启动（首次启动要下载镜像和初始化数据库，大约 2-5 分钟）...
echo.
docker compose up -d
if errorlevel 1 (
  echo.
  echo   [X] 启动失败。常见原因：
  echo       - Docker Desktop 还没启动完成，等它图标变绿再试
  echo       - 端口 8787 被占用，改 .env 里的 PORT
  echo.
  pause
  exit /b 1
)

echo.
echo   等待服务就绪...
set /a tries=0
:wait
set /a tries+=1
timeout /t 3 /nobreak >nul
curl -s -o nul http://127.0.0.1:8787/api/health 2>nul
if errorlevel 1 (
  if %tries% lss 40 goto wait
  echo   [!] 等太久还没起来，看日志：docker compose logs app
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     启动成功
echo   ============================================================
echo.
for /f "tokens=2 delims==" %%a in ('findstr /b "PORT=" .env 2^>nul') do set PORT=%%a
if "%PORT%"=="" set PORT=8787
echo     本机访问：  http://localhost:%PORT%
echo     管理界面：  http://localhost:9001   （MinIO，看附件用）
echo.
echo     停止服务双击  stop.bat
echo.
start "" http://localhost:%PORT%
echo   按任意键关闭本窗口（服务继续在后台运行）...
pause >nul