@echo off
setlocal
set "HOOK_LOG=%~dp0..\..\relay\.data\hook-launch.log"
>>"%HOOK_LOG%" echo [%TIME%] prompt_capture_entered
"C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" "%~dp0capture_prompt.py" %*
set "PYTHON_EXIT=%ERRORLEVEL%"
>>"%HOOK_LOG%" echo [%TIME%] prompt_capture_exit=%PYTHON_EXIT%
rem Prompt capture is observational and must never block Codex.
exit /b 0
