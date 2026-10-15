@echo off
setlocal
set "TEST_DIR=%~dp0"
set "ROOT=%~dp0.."
set "PATTERN=%~1"
if "%PATTERN%"=="" set "PATTERN=*.test.js"

echo ROOT=%ROOT%
echo DIR=%TEST_DIR%
echo PATTERN=%PATTERN%

dir "%ROOT%\test-results.xml" >nul 2>&1
if %errorlevel%==0 (
    echo Removing existing test-results.xml
    del /Q "%ROOT%\test-results.xml"
)

cd /d "%ROOT%"

set "ARGS=--test"
for /f "delims=" %%F in ('dir /b /s "%TEST_DIR%%PATTERN%" 2^>nul') do (
    set "ARGS=%ARGS% "%%~F""
)
set "ARGS=%ARGS% --test-reporter=./jest-reporter.js"

echo Running: node %ARGS%
node %ARGS%
set EXITCODE=%errorlevel%

if exist "%ROOT%\test-results.xml" (
    for %%F in ("%ROOT%\test-results.xml") do echo test-results.xml size=%%~zF
) else (
    echo test-results.xml not created
)

exit /b %EXITCODE%
