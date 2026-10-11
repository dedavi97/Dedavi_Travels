@echo off
REM Starts a local web server for testing and opens the site in the browser.
REM (Opening index.html directly does not work: browsers block loading local data files.)
cd /d "%~dp0"
python --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python is not installed, so the local test server cannot start.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^),
  echo then run this file again.
  echo.
  pause
  exit /b 1
)
echo Starting the site at http://localhost:8000
echo Close this window to stop it.
start "" http://localhost:8000
python -m http.server 8000
