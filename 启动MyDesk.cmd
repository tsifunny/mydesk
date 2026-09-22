@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" "tools\launch.cjs"
) else (
  where node.exe >nul 2>nul
  if errorlevel 1 (
    echo Node.js was not found. Please use the complete Windows portable ZIP.
    echo 未找到运行环境。请使用完整解压的 Windows 便携包，或安装 Node.js 24.16 以上版本。
    pause
    exit /b 1
  )
  node.exe "tools\launch.cjs"
)
if errorlevel 1 pause
endlocal
