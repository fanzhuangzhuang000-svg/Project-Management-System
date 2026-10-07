@echo off
title 弱电智能化工程项目管理系统
cd /d "%~dp0"

set "NODEEXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%i"
if not defined NODEEXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODEEXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODEEXE (
  echo.
  echo   [错误] 没有找到 Node.js 运行环境。
  echo   请先安装 Node.js 18 或更高版本，再重新双击本文件：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "data" mkdir "data"
if not exist "backup" mkdir "backup"

rem 前端是 React 构建产物。正常情况下 public\index.html 已经存在，直接启动；
rem 只有在产物缺失时（比如第一次拿到源码、或误删了 public）才需要重新构建。
if not exist "public\index.html" (
  echo.
  echo   [提示] 没找到前端构建产物，正在构建，首次可能需要 1-2 分钟……
  call "%~dp0构建前端.bat" --auto
  rem 构建脚本内部会 cd 到 web 目录，call 返回后当前目录还停在那里，
  rem 必须切回项目根目录，否则下面找不到 server.js
  cd /d "%~dp0"
  if not exist "public\index.html" (
    echo.
    echo   [错误] 前端构建失败，请查看上面的提示。
    echo   如果缺少依赖，请先在 web 目录执行：npm install
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   ==========================================================
echo      弱电智能化工程项目管理系统
echo   ==========================================================
echo.
echo      本机地址： http://127.0.0.1:8787
echo      关闭本窗口即停止服务
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8787"

"%NODEEXE%" --no-warnings server.js --port 8787

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
