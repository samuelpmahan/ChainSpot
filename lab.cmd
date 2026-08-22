@echo off
setlocal

if /I not "%~1"=="orient" goto usage
if /I not "%~2"=="3fd72" goto usage

if "%~3"=="" goto run
if /I "%~3"=="--verbose" if "%~4"=="" goto runVerbose
goto usage

:run
node "%~dp0scripts\lab-orient-3fd72.mjs"
exit /b %errorlevel%

:runVerbose
node "%~dp0scripts\lab-orient-3fd72.mjs" --verbose
exit /b %errorlevel%

:usage
echo Usage: lab orient 3fd72 [--verbose]
exit /b 2
