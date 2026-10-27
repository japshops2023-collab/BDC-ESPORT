@echo off
cd /d "%~dp0"
set AUTO_OPEN=1
if exist ".runtime\node\node.exe" (
  ".runtime\node\node.exe" server.js
) else (
  node server.js
)
pause
