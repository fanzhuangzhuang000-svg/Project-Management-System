@echo off
title 备份项目管理系统数据
cd /d "%~dp0"

set "NODEEXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%i"
if not defined NODEEXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODEEXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODEEXE (
  echo.
  echo   [错误] 没有找到 Node.js 运行环境，无法备份。
  echo.
  pause
  exit /b 1
)

set "TS="
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
if not defined TS set "TS=manual"

echo.
echo   ==========================================================
echo      正在备份
echo   ==========================================================
echo.

rem ---- 1. 数据库：用 SQLite 的 VACUUM INTO，产出一份完整一致的副本 ----
"%NODEEXE%" --no-warnings tools\backup.js
if errorlevel 1 (
  echo.
  echo   [错误] 数据库备份失败，请把上面的信息截图反馈。
  echo.
  pause
  exit /b 1
)

rem ---- 2. 附件：统计实际文件数，有才打包 ----
set "NF=0"
if exist "data\attachments" (
  for /f %%c in ('dir /b /s /a-d "data\attachments" 2^>nul ^| find /c /v ""') do set "NF=%%c"
)
if not "%NF%"=="0" (
  echo   正在打包 %NF% 个附件扫描件...
  powershell -NoProfile -Command "Compress-Archive -Path 'data\attachments\*' -DestinationPath 'backup\attachments_%TS%.zip' -Force" 2>nul
  if exist "backup\attachments_%TS%.zip" (
    echo   附件已打包： backup\attachments_%TS%.zip
  ) else (
    echo   [提示] 附件打包失败，请手工复制 data\attachments 文件夹。
  )
) else (
  echo   暂无附件，跳过打包。
)

echo.
echo   ==========================================================
echo      备份完成
echo   ==========================================================
echo   文件位置： %~dp0backup
echo     pms_日期_时间.db        数据库（合同、收付款、发票、材料等全部数据）
echo     attachments_%TS%.zip    附件扫描件（如有）
echo.
echo   建议把 backup 文件夹里的文件再复制一份到网盘或移动硬盘。
echo   系统自动保留最近 30 份数据库备份，附件包请自行清理旧文件。
echo.
pause
