@echo off
setlocal EnableExtensions
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
set "DEST=%LOCALAPPDATA%\Programs\KeyCat"
set "VER=1.0.1"

echo.
echo  KeyCat %VER% setup
echo  --------------------------------------------
echo  From: %SRC%
echo  To  : %DEST%
echo.

if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1
robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
if errorlevel 8 goto copyfail
del "%DEST%\install.cmd" >nul 2>&1
echo  [1/3] files copied

powershell -NoProfile -ExecutionPolicy Bypass -Command "$dest='%DEST%'; $exe=Join-Path $dest 'KeyCat.exe'; $sh=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $l=$sh.CreateShortcut((Join-Path $d 'KeyCat.lnk')); $l.TargetPath=$exe; $l.WorkingDirectory=$dest; $l.IconLocation=$exe; $l.Save(); $m=Join-Path ([Environment]::GetFolderPath('Programs')) 'KeyCat'; New-Item -ItemType Directory -Force -Path $m | Out-Null; $l2=$sh.CreateShortcut((Join-Path $m 'KeyCat.lnk')); $l2.TargetPath=$exe; $l2.WorkingDirectory=$dest; $l2.IconLocation=$exe; $l2.Save()"
if errorlevel 1 echo  [!] shortcut creation failed, you can pin KeyCat.exe manually.
echo  [2/3] shortcuts created

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v DisplayName /t REG_SZ /d "KeyCat" >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v DisplayVersion /t REG_SZ /d "%VER%" >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v Publisher /t REG_SZ /d "KeyCat" >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v InstallLocation /t REG_SZ /d "%DEST%" >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v DisplayIcon /t REG_SZ /d "%DEST%\KeyCat.exe" >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v UninstallString /t REG_SZ /d "\"%DEST%\uninstall.cmd\"" >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v NoModify /t REG_DWORD /d 1 >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KeyCat" /f /v NoRepair /t REG_DWORD /d 1 >nul
echo  [3/3] uninstall entry registered

echo.
echo  Starting KeyCat ...
start "" "%DEST%\KeyCat.exe"
timeout /t 3 >nul
echo.
echo  Tray icon is near the clock (may be hidden in the ^^ menu).
echo  Hotkeys: Ctrl+Alt+E edit mode / Ctrl+Alt+H show-hide / Ctrl+Alt+S settings
echo.
pause
exit /b 0

:copyfail
echo  [!] Copy failed. Check disk space and folder permissions.
pause
exit /b 1
