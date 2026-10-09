@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect_clipboard_diagnostics.ps1" -ProbeClipboardAccess %*
if errorlevel 1 echo Collection failed. Keep this window's error message for diagnosis.
echo.
echo Reports: %%LOCALAPPDATA%%\Writing Agent\diagnostics\clipboard
pause
endlocal
