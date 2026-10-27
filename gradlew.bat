@echo off
pushd "%~dp0jetbrains"
call gradlew.bat %*
set ERR=%ERRORLEVEL%
popd
exit /b %ERR%
