@echo off
setlocal

set "HOOK_LOG=%CODEXY_HOOK_LOG%"
if not defined HOOK_LOG set "HOOK_LOG=%USERPROFILE%\.codex\codexy\hook.log"
for %%I in ("%HOOK_LOG%") do if not exist "%%~dpI" mkdir "%%~dpI" >nul 2>nul

>>"%HOOK_LOG%" echo [%DATE% %TIME%] notify_entered
if exist "%HOOK_LOG%" for %%A in ("%HOOK_LOG%") do if %%~zA GTR 1048576 move /y "%HOOK_LOG%" "%HOOK_LOG%.1" >nul 2>nul
set "CODEXY_HOOK_NODE=%CODEXY_NODE%"
if not defined CODEXY_HOOK_NODE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined CODEXY_HOOK_NODE set "CODEXY_HOOK_NODE=%%I"
if not defined CODEXY_HOOK_NODE (
  >>"%HOOK_LOG%" echo [%DATE% %TIME%] notify_skipped=node_not_found
  exit /b 0
)

"%CODEXY_HOOK_NODE%" "%~dp0notify_mobile.mjs" %* >>"%HOOK_LOG%" 2>&1
goto :finished

:finished
set "NODE_EXIT=%ERRORLEVEL%"
>>"%HOOK_LOG%" echo [%DATE% %TIME%] notify_exit=%NODE_EXIT%

rem Notification delivery is observational and must never block Codex.
exit /b 0
