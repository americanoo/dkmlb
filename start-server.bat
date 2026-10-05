@echo off
rem Double-click on Windows to start the local stats server and open the site.
cd /d "%~dp0"
where python >nul 2>nul || (echo Python 3 is needed. Install it from https://www.python.org/downloads/ and run this again. & pause & exit /b 1)
if not exist server\.venv\Scripts\python.exe (
  echo First run: setting up ^(takes a minute^)...
  python -m venv server\.venv || (pause & exit /b 1)
)
server\.venv\Scripts\python -m pip install -q --disable-pip-version-check -r server\requirements.txt || (pause & exit /b 1)
server\.venv\Scripts\python server\server.py --open %*
pause
