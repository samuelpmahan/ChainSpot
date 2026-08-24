@echo off
setlocal

set "LAB_DIR=%~dp0scripts\chainspot-lab"
set "TSX=%LAB_DIR%\node_modules\.bin\tsx.cmd"

if "%~1"=="" goto help
if /I "%~1"=="--help" goto help
if /I "%~1"=="-h" goto help
if /I "%~1"=="help" goto help

if /I "%~1"=="orient" goto orient

if not exist "%TSX%" (
  echo LAB dependencies are not installed. Run: ^(cd scripts\chainspot-lab ^&^& npm install^)
  exit /b 1
)

if /I "%~1"=="invariants" goto knowledge
if /I "%~1"=="detectors" goto knowledge
if /I "%~1"=="gates" goto knowledge
if /I "%~1"=="cases" goto knowledge
if /I "%~1"=="compile" goto sweep
if /I "%~1"=="sweep" goto sweep
if /I "%~1"=="scope" goto scope
goto usage

:knowledge
"%TSX%" "%LAB_DIR%\%~1.ts" %2
exit /b %errorlevel%

:sweep
"%TSX%" "%LAB_DIR%\sweep\sweepCli.ts" %*
exit /b %errorlevel%

:scope
REM Pass %* intact; scopeCli strips the leading 'scope'. This avoids the
REM nine-positional-argument limit for long dot/path traces.
"%TSX%" "%LAB_DIR%\scope\scopeCli.ts" %*
exit /b %errorlevel%

:orient
if /I not "%~2"=="3fd72" goto usage
if "%~3"=="" (
  node "%~dp0scripts\lab-orient-3fd72.mjs"
  exit /b %errorlevel%
)
if /I "%~3"=="--verbose" if "%~4"=="" (
  node "%~dp0scripts\lab-orient-3fd72.mjs" --verbose
  exit /b %errorlevel%
)
goto usage

:help
echo LAB - tools for seeing, measuring, testing, and learning ChainSpot CV
echo.
echo LOOK
echo   scope        inspect image regions, trace geometry/search, batch, contact-sheet
echo.
echo KNOW
echo   invariants   observed renderer truths
echo   detectors    detector registry
echo   gates        pipeline/gate vocabulary
echo   cases        hard-evidence cases
echo.
echo RUN
echo   compile      inspect/compile an algorithm config ^(no raster execution^)
echo   sweep        execute a config against raster input through the LAB gateway
echo.
echo PROVENANCE
echo   orient 3fd72 [--verbose]
echo.
echo Discover from here:
echo   lab scope --help
echo   lab compile --help
echo   lab sweep --help
exit /b 0

:usage
call :help
exit /b 2
