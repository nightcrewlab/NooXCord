@echo off
rem NooXCord: one-click installer build -> release\NooXCord-Setup-<version>.exe
rem Version comes from apps\desktop\package.json (raise it there before a new release).
setlocal
cd /d "%~dp0"

for /f "delims=" %%v in ('node -p "require('./apps/desktop/package.json').version"') do set VER=%%v
if "%VER%"=="" (
  echo [HATA] Surum okunamadi. Node.js kurulu mu?
  pause
  exit /b 1
)

echo ============================================
echo   NooXCord %VER% paketleniyor...
echo ============================================
echo.

call pnpm dist
if errorlevel 1 (
  echo.
  echo [HATA] Paketleme basarisiz. Yukaridaki ciktiya bak.
  pause
  exit /b 1
)

echo.
echo [TAMAM] release\NooXCord-Setup-%VER%.exe hazir.
explorer /select,"%~dp0release\NooXCord-Setup-%VER%.exe"
pause
