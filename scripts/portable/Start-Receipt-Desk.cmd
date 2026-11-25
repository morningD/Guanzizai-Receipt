@echo off
"%~dp0runtime\node.exe" "%~dp0bootstrap.mjs" %*
set "exit_code=%ERRORLEVEL%"
if not "%exit_code%"=="0" if not "%~1"=="--no-browser" pause
exit /b %exit_code%
