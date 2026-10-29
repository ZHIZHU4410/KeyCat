@echo off
setlocal EnableExtensions
set "DEST=%LOCALAPPDATA%\Programs\KeyCat"

if /i "%~1"=="/quiet" goto quiet

echo.
echo  Uninstall KeyCat
echo  --------------------------------------------
echo  Install dir : %DEST%
echo  Config kept : %APPDATA%\KeyCat
echo.
choice /c YN /m "Remove KeyCat"
if errorlevel 2 exit /b 0

taskkill /f /im KeyCat.exe >nul 2>&1
copy /y "%~f0" "%TEMP%\keycat-uninstall-run.cmd" >nul 2>&1
start "" cmd /c ""%TEMP%\keycat-uninstall-run.cmd" /quiet"
exit /b 0

:quiet
taskkill /f /im KeyCat.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul
del "%USERPROFILE%\Desktop\KeyCat.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\KeyCat\KeyCat.lnk" >nul 2>&1
rd "%APPDATA%\Microsoft\Windows\Start Menu\Programs\KeyCat" >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f >nul 2>&1
rd /s /q "%DEST%" >nul 2>&1
del "%TEMP%\keycat-uninstall-run.cmd" >nul 2>&1
exit /b 0
