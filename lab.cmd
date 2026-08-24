@echo off
setlocal
node "%~dp0scripts\chainspot-lab\bin\lab.mjs" %*
exit /b %errorlevel%
