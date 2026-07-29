@echo off
setlocal

set "HOOK_LOG=%CODEXY_HOOK_LOG%"
if not defined HOOK_LOG set "HOOK_LOG=%USERPROFILE%\.codex\codexy\hook.log"
for %%I in ("%HOOK_LOG%") do if not exist "%%~dpI" mkdir "%%~dpI" >nul 2>nul

>>"%HOOK_LOG%" echo [%DATE% %TIME%] prompt_capture_entered
if defined CODEXY_PYTHON (
  "%CODEXY_PYTHON%" "%~dp0capture_prompt.py" %*
  goto :finished
)

where py.exe >nul 2>nul
if not errorlevel 1 (
  py.exe -3 "%~dp0capture_prompt.py" %*
  goto :finished
)

where python.exe >nul 2>nul
if not errorlevel 1 (
  python.exe "%~dp0capture_prompt.py" %*
  goto :finished
)

>>"%HOOK_LOG%" echo [%DATE% %TIME%] prompt_capture_skipped=python_not_found
exit /b 0

:finished
set "PYTHON_EXIT=%ERRORLEVEL%"
>>"%HOOK_LOG%" echo [%DATE% %TIME%] prompt_capture_exit=%PYTHON_EXIT%

rem Prompt capture is observational and must never block Codex.
exit /b 0
