@echo off
title 构建前端界面
cd /d "%~dp0"

echo.
echo   ==========================================================
echo      构建前端界面（React + TypeScript + Tailwind）
echo   ==========================================================
echo.

if not exist "web" (
  echo   [错误] 没有找到 web 目录。
  pause
  exit /b 1
)

set "NODEEXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%i"
if not defined NODEEXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODEEXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODEEXE (
  echo   [错误] 没有找到 Node.js，请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)

cd /d "%~dp0web"

if not exist "node_modules" (
  echo   首次构建，正在安装依赖（约 1-2 分钟）……
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败。请检查网络后重试。
    pause
    exit /b 1
  )
)

echo   正在编译……
echo.
call npm run build
if errorlevel 1 (
  echo.
  echo   [错误] 编译失败，请把上面的错误信息发给技术人员。
  pause
  exit /b 1
)

echo.
echo   ==========================================================
echo      构建完成，产物已输出到 public 目录
echo      直接双击「启动系统.bat」即可使用新界面
echo   ==========================================================
echo.

if /i not "%~1"=="--auto" pause >nul
rem 回到项目根目录，避免影响调用方（启动系统.bat 会 call 本脚本）
cd /d "%~dp0.."
exit /b 0
