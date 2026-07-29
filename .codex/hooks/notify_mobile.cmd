@echo off
setlocal

set "HOOK_LOG=%~dp0..\..\relay\.data\hook-launch.log"

>>"%HOOK_LOG%" echo [%TIME%] launcher_entered

"C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" "%~dp0notify_mobile.py" %*
set "PYTHON_EXIT=%ERRORLEVEL%"

>>"%HOOK_LOG%" echo [%TIME%] python_exit=%PYTHON_EXIT%

rem Mobile notification delivery is observational and must never block Codex.
exit /b 0
