@echo off
REM One-command server bootstrap for Windows: install, .env, migrate+import, run.
REM   start.bat            use the DB configured in .env
REM   set START_DB=1 ^&^& start.bat   also start the bundled Postgres via docker
cd /d "%~dp0"

echo [1/5] Installing dependencies...
call npm install --no-audit --no-fund || goto :err

echo [2/5] Ensuring .env...
call node scripts\ensure-env.js || goto :err

if "%START_DB%"=="1" (
  echo [3/5] Starting bundled PostgreSQL ^(docker compose^)...
  call docker compose up -d || goto :err
  echo       waiting 8s for PostgreSQL...
  timeout /t 8 /nobreak >nul
) else (
  echo [3/5] Using DATABASE_URL from .env ^(set START_DB=1 to auto-start the bundled DB^).
)

echo [4/5] Creating tables + importing employees...
call npm run setup || goto :err

echo [5/5] Starting server...
call npm start
goto :eof

:err
echo.
echo Bootstrap failed. Check the message above (usually the database is not reachable).
exit /b 1
