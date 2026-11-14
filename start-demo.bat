@echo off
rem SignalSpeak hands-free demo launcher (Windows).
rem Starts the local server, then opens Chrome (or Edge) with flags so that NOTHING has to be clicked,
rem allowed or dismissed once the page is up:
rem   --use-fake-ui-for-media-stream        camera permission is granted automatically (real camera; the app never asks for the mic)
rem   --autoplay-policy=no-user-gesture-required   speech + alarm sounds play without a first click
rem   --no-first-run --no-default-browser-check     no welcome / "make default" screens
rem   --disable-session-crashed-bubble --hide-crash-restore-bubble   no "restore pages?" bar
rem   --disable-notifications --disable-features=Translate,...        no notification / translate / sign-in prompts
rem   --user-data-dir=<private profile>     flags apply even if Chrome is already open; calibration persists between runs
rem   --app=<url> --start-fullscreen        no address bar or tabs; exit with Alt+F4
rem Chrome flags reference: https://peter.sh/experiments/chromium-command-line-switches/ [17]
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
  --no-first-run --no-default-browser-check ^
  --disable-session-crashed-bubble --hide-crash-restore-bubble ^
  --disable-notifications --disable-infobars ^
  --disable-features=Translate,TranslateUI,PasswordManagerOnboarding,PrivacySandboxSettings4,SigninInterceptBubble,msEdgeSignIn ^
  --start-fullscreen ^
  --app=%URL%
endlocal
