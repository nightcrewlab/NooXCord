@echo off
rem NooXCord: commit + push, then upload the built installer to GitHub Releases
rem (auto-update feed, CLAUDE.md 17.18). Run paketle.bat first. Needs git and the GitHub CLI (gh) signed in.
setlocal
cd /d "%~dp0"

for /f "delims=" %%v in ('node -p "require('./apps/desktop/package.json').version"') do set VER=%%v
if "%VER%"=="" (
  echo [HATA] Surum okunamadi. Node.js kurulu mu?
  pause
  exit /b 1
)

set EXE=release\NooXCord-Setup-%VER%.exe
set MAP=release\NooXCord-Setup-%VER%.exe.blockmap
set YML=release\latest.yml

for %%f in ("%EXE%" "%MAP%" "%YML%") do (
  if not exist %%f (
    echo [HATA] %%f bulunamadi. Once paketle.bat calistir.
    pause
    exit /b 1
  )
)

findstr /c:"version: %VER%" "%YML%" >nul
if errorlevel 1 (
  echo [HATA] latest.yml %VER% surumune ait degil. Once paketle.bat calistir.
  pause
  exit /b 1
)

where gh >nul 2>&1
if errorlevel 1 (
  echo [HATA] GitHub CLI ^(gh^) bulunamadi: https://cli.github.com
  pause
  exit /b 1
)

gh release view v%VER% >nul 2>&1
if not errorlevel 1 (
  echo [HATA] v%VER% zaten yayinlanmis. apps\desktop\package.json surumunu artir, paketle.bat, sonra tekrar dene.
  pause
  exit /b 1
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b

echo ============================================
echo   NooXCord v%VER%  (dal: %BRANCH%)
echo   1^) Degisiklikler commit edilir
echo   2^) GitHub'a push edilir
echo   3^) %EXE% release olarak yuklenir
echo   Kurulu uygulamalar bu surumu otomatik indirecek.
echo ============================================
git status --short
echo.
choice /c EH /m "Devam edilsin mi? (E=Evet, H=Hayir)"
if errorlevel 2 (
  echo Iptal edildi.
  pause
  exit /b 0
)

rem ---- 1) commit (only when something changed) ----
set DIRTY=
for /f "delims=" %%s in ('git status --porcelain') do set DIRTY=1
if not defined DIRTY (
  echo Commit edilecek degisiklik yok.
  goto push
)
set MSG=
set /p MSG="Commit mesaji [bos = chore(release): v%VER%]: "
if "%MSG%"=="" set "MSG=chore(release): v%VER%"
git add -A
git commit -m "%MSG%"
if errorlevel 1 (
  echo [HATA] Commit basarisiz.
  pause
  exit /b 1
)

:push

rem ---- 2) push ----
git push -u origin %BRANCH%
if errorlevel 1 (
  echo [HATA] Push basarisiz. Yukaridaki ciktiya bak.
  pause
  exit /b 1
)

rem ---- 3) release, tagged exactly at the pushed commit ----
for /f "delims=" %%h in ('git rev-parse HEAD') do set SHA=%%h
gh release create v%VER% "%EXE%" "%MAP%" "%YML%" --target %SHA% --title "NooXCord %VER%" --generate-notes
if errorlevel 1 (
  echo.
  echo [HATA] Yukleme basarisiz. Yukaridaki ciktiya bak.
  pause
  exit /b 1
)

echo.
echo [TAMAM] v%VER% yayinlandi.
gh release view v%VER% --web
pause
