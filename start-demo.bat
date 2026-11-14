@echo off
rem SignalSpeak hands-free demo launcher (Windows).
rem Starts the local server, then opens Chrome with flags that:
rem   - pre-grant the camera (no "Allow camera?" prompt; the app never requests the microphone)
rem   - allow speech/sound without a click (Chrome normally blocks audio until the page is clicked)
rem   - use a private profile so the flags apply even if Chrome is already open, and so calibration persists
rem Once the page is up, nothing needs to be clicked or typed. Exit Chrome with Alt+F4.
rem Chrome flags reference: https://peter.sh/experiments/chromium-command-line-switches/
rem AI-assisted: written with help from Claude (Anthropic).
setlocal
cd /d "%~dp0"

set PORT=5173
set URL=http://localhost:%PORT%/
set PROFILE=%LOCALAPPDATA%\SignalSpeak\chrome-profile

rem --- find Chrome (fall back to Edge, which takes the same flags) ---
set BROWSER=
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do (
  if not defined BROWSER if exist %%P set BROWSER=%%P
)
if not defined BROWSER (
  echo Could not find Chrome or Edge. Install Chrome, or open %URL% yourself.
  pause
  exit /b 1
)

rem --- start the dev server in its own window (skip if already running) ---
powershell -NoProfile -Command "exit [int](-not (Test-NetConnection localhost -Port %PORT% -InformationLevel Quiet -WarningAction SilentlyContinue))" >nul 2>&1
if errorlevel 1 (
  start "SignalSpeak server" cmd /k npm run dev -- --port %PORT% --strictPort
)

rem --- wait until the server answers ---
echo Waiting for the server on %URL% ...
for /l %%i in (1,1,60) do (
  powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing %URL% -TimeoutSec 1) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 goto up
  timeout /t 1 /nobreak >nul
)
echo Server did not start. Check the "SignalSpeak server" window.
pause
exit /b 1

:up
if not exist "%PROFILE%" mkdir "%PROFILE%"
start "" %BROWSER% ^
  --user-data-dir="%PROFILE%" ^
  --use-fake-ui-for-media-stream ^
  --autoplay-policy=no-user-gesture-required ^
  --no-first-run --no-default-browser-check --disable-session-crashed-bubble ^
  --start-fullscreen ^
  --app=%URL%
endlocal
