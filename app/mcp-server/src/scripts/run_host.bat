@echo off
setlocal DisableDelayedExpansion

REM Keep every environment-derived value inside a quoted command argument.
REM Do not use CALL for executables: CALL reparses percent expansions and turns
REM otherwise-valid path characters into cmd.exe syntax.
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "NODE_SCRIPT=%SCRIPT_DIR%\index.js"
set "LOG_RUNNER_SCRIPT=%SCRIPT_DIR%\scripts\native-log-runner.js"

REM Prefer a user-writable log directory.
if defined LOCALAPPDATA set "LOG_DIR=%LOCALAPPDATA%\webpage-mcp\logs"
if not defined LOG_DIR set "LOG_DIR=%TEMP%\webpage-mcp\logs"
if exist "%LOG_DIR%\." goto log_dir_ready
mkdir "%LOG_DIR%" 2>nul
if exist "%LOG_DIR%\." goto log_dir_ready
set "LOG_DIR=%SCRIPT_DIR%\logs"
if not exist "%LOG_DIR%\." mkdir "%LOG_DIR%" 2>nul

:log_dir_ready
set "RUN_ID=%RANDOM%_%RANDOM%_%RANDOM%"
set "WRAPPER_LOG=%LOG_DIR%\native_host_wrapper_windows_%RUN_ID%.log"
set "STDERR_LOG=%LOG_DIR%\native_host_stderr_windows_%RUN_ID%.log"
type nul > "%STDERR_LOG%"

REM The Node supervisor enforces byte limits and retention on every platform.
set "WEBPAGE_MCP_WRAPPER_LOG_PATH=%WRAPPER_LOG%"
set "WEBPAGE_MCP_STDERR_LOG_PATH=%STDERR_LOG%"
if not defined WEBPAGE_MCP_WRAPPER_LOG_MAX_BYTES set "WEBPAGE_MCP_WRAPPER_LOG_MAX_BYTES=1048576"
if not defined WEBPAGE_MCP_STDERR_LOG_MAX_BYTES set "WEBPAGE_MCP_STDERR_LOG_MAX_BYTES=8388608"
if not defined WEBPAGE_MCP_LOG_RETENTION_COUNT set "WEBPAGE_MCP_LOG_RETENTION_COUNT=5"

> "%WRAPPER_LOG%" echo Wrapper script called at "%DATE% %TIME%"
>> "%WRAPPER_LOG%" echo SCRIPT_DIR: "%SCRIPT_DIR%"
>> "%WRAPPER_LOG%" echo LOG_DIR: "%LOG_DIR%"
>> "%WRAPPER_LOG%" echo NODE_SCRIPT: "%NODE_SCRIPT%"
>> "%WRAPPER_LOG%" echo User: "%USERNAME%"
if defined WEBPAGE_MCP_NODE_PATH >> "%WRAPPER_LOG%" echo WEBPAGE_MCP_NODE_PATH is set
if defined VOLTA_HOME >> "%WRAPPER_LOG%" echo VOLTA_HOME is set
if defined ASDF_DATA_DIR >> "%WRAPPER_LOG%" echo ASDF_DATA_DIR is set
if defined FNM_DIR >> "%WRAPPER_LOG%" echo FNM_DIR is set

set "NODE_EXEC="
set "NODE_EXEC_SOURCE="

REM Priority 0: explicit override.
if not defined WEBPAGE_MCP_NODE_PATH goto node_path_file
set "CANDIDATE_NODE=%WEBPAGE_MCP_NODE_PATH%"
if exist "%CANDIDATE_NODE%\." set "CANDIDATE_NODE=%CANDIDATE_NODE%\node.exe"
if not exist "%CANDIDATE_NODE%" goto node_path_file
set "NODE_EXEC=%CANDIDATE_NODE%"
set "NODE_EXEC_SOURCE=WEBPAGE_MCP_NODE_PATH"
goto node_found

:node_path_file
REM Priority 1: installation-time path captured by postinstall.
set "NODE_PATH_FILE=%SCRIPT_DIR%\node_path.txt"
if not exist "%NODE_PATH_FILE%" goto relative_node
set "EXPECTED_NODE="
set /p EXPECTED_NODE=<"%NODE_PATH_FILE%"
if not exist "%EXPECTED_NODE%" goto relative_node
set "NODE_EXEC=%EXPECTED_NODE%"
set "NODE_EXEC_SOURCE=node_path.txt"
goto node_found

:relative_node
REM Priority 1.5: package-relative node.exe.
set "EXPECTED_NODE=%SCRIPT_DIR%\..\..\..\node.exe"
if not exist "%EXPECTED_NODE%" goto volta_node
set "NODE_EXEC=%EXPECTED_NODE%"
set "NODE_EXEC_SOURCE=relative"
goto node_found

:volta_node
REM Priority 2: Volta.
if not defined VOLTA_HOME goto volta_default
set "EXPECTED_NODE=%VOLTA_HOME%\bin\node.exe"
if not exist "%EXPECTED_NODE%" goto asdf_node
set "NODE_EXEC=%EXPECTED_NODE%"
set "NODE_EXEC_SOURCE=volta"
goto node_found

:volta_default
set "EXPECTED_NODE=%USERPROFILE%\.volta\bin\node.exe"
if not exist "%EXPECTED_NODE%" goto asdf_node
set "NODE_EXEC=%EXPECTED_NODE%"
set "NODE_EXEC_SOURCE=volta"
goto node_found

:asdf_node
REM Priority 3: newest numeric asdf install. PowerShell reads environment
REM variables directly, so no environment-derived path is interpolated into
REM the command text.
set "ASDF_NODE="
for /f "delims=" %%i in ('powershell -NoProfile -NonInteractive -Command "$base=$env:ASDF_DATA_DIR; if(-not $base){$base=Join-Path $env:USERPROFILE '.asdf'}; $root=Join-Path $base 'installs\nodejs'; $best=$null; if(Test-Path -LiteralPath $root){ foreach($d in (Get-ChildItem -Directory -LiteralPath $root -ErrorAction SilentlyContinue)){ if($d.Name -match '^v?\d+(\.\d+){1,3}$'){ $v=[version]($d.Name -replace '^v',''); if(-not $best -or $v -gt $best.Ver){ $best=[pscustomobject]@{Ver=$v;Dir=$d.FullName} } } } }; if($best){ $p=Join-Path $best.Dir 'bin\node.exe'; if(Test-Path -LiteralPath $p){ Write-Output $p } }" 2^>nul') do set "ASDF_NODE=%%i"
if not defined ASDF_NODE goto fnm_node
set "NODE_EXEC=%ASDF_NODE%"
set "NODE_EXEC_SOURCE=asdf"
goto node_found

:fnm_node
REM Priority 4: newest numeric fnm install.
set "FNM_NODE="
for /f "delims=" %%i in ('powershell -NoProfile -NonInteractive -Command "$base=$env:FNM_DIR; if(-not $base){$base=Join-Path $env:USERPROFILE '.fnm'}; $root=Join-Path $base 'node-versions'; $best=$null; if(Test-Path -LiteralPath $root){ foreach($d in (Get-ChildItem -Directory -LiteralPath $root -ErrorAction SilentlyContinue)){ if($d.Name -match '^v?\d+(\.\d+){1,3}$'){ $v=[version]($d.Name -replace '^v',''); if(-not $best -or $v -gt $best.Ver){ $best=[pscustomobject]@{Ver=$v;Dir=$d.FullName} } } } }; if($best){ $p=Join-Path $best.Dir 'installation\node.exe'; if(Test-Path -LiteralPath $p){ Write-Output $p } }" 2^>nul') do set "FNM_NODE=%%i"
if not defined FNM_NODE goto path_node
set "NODE_EXEC=%FNM_NODE%"
set "NODE_EXEC_SOURCE=fnm"
goto node_found

:path_node
REM Priority 5: PATH. Keep only the first result.
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE_EXEC set "NODE_EXEC=%%i"
if not defined NODE_EXEC goto common_node_program_files
set "NODE_EXEC_SOURCE=where"
goto node_found

:common_node_program_files
REM Priority 6: common installation paths.
set "EXPECTED_NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%EXPECTED_NODE%" goto common_node_program_files_x86
set "NODE_EXEC=%EXPECTED_NODE%"
set "NODE_EXEC_SOURCE=common"
goto node_found

:common_node_program_files_x86
set "EXPECTED_NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not exist "%EXPECTED_NODE%" goto common_node_local_app_data
set "NODE_EXEC=%EXPECTED_NODE%"
set "NODE_EXEC_SOURCE=common"
goto node_found

:common_node_local_app_data
set "EXPECTED_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%EXPECTED_NODE%" goto node_missing
set "NODE_EXEC=%EXPECTED_NODE%"
set "NODE_EXEC_SOURCE=common"
goto node_found

:node_missing
>> "%WRAPPER_LOG%" echo ERROR: Node.js executable not found
>> "%WRAPPER_LOG%" echo Set WEBPAGE_MCP_NODE_PATH or run webpage-mcp doctor --fix
endlocal & exit /B 1

:node_found
>> "%WRAPPER_LOG%" echo Node discovery source: "%NODE_EXEC_SOURCE%"
"%NODE_EXEC%" -v >> "%WRAPPER_LOG%" 2>&1
if errorlevel 1 goto node_failed

if not exist "%NODE_SCRIPT%" goto node_script_missing
if not exist "%LOG_RUNNER_SCRIPT%" goto log_runner_missing

REM Add the selected Node directory without reparsing the inherited PATH.
for %%I in ("%NODE_EXEC%") do set "NODE_BIN_DIR=%%~dpI"
set "PATH=%NODE_BIN_DIR%;%PATH%"

REM Load the module path captured during runtime bootstrap.
set "NODE_MODULES_PATH_FILE=%SCRIPT_DIR%\node_modules_path.txt"
if not exist "%NODE_MODULES_PATH_FILE%" goto modules_ready
set "MODULES_PATH="
set /p MODULES_PATH=<"%NODE_MODULES_PATH_FILE%"
if not exist "%MODULES_PATH%\." goto modules_ready
if not defined NODE_PATH goto modules_path_only
set "NODE_PATH=%MODULES_PATH%;%NODE_PATH%"
goto modules_ready

:modules_path_only
set "NODE_PATH=%MODULES_PATH%"

:modules_ready
if defined ANTHROPIC_BASE_URL >> "%WRAPPER_LOG%" echo ANTHROPIC_BASE_URL is set ^(value hidden^)
if defined ANTHROPIC_AUTH_TOKEN >> "%WRAPPER_LOG%" echo ANTHROPIC_AUTH_TOKEN is set ^(value hidden^)
>> "%WRAPPER_LOG%" echo Starting native log supervisor
"%NODE_EXEC%" "%LOG_RUNNER_SCRIPT%" "%NODE_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /B %EXIT_CODE%

:node_failed
>> "%WRAPPER_LOG%" echo ERROR: Selected Node.js executable failed validation
endlocal & exit /B 1

:node_script_missing
>> "%WRAPPER_LOG%" echo ERROR: Node.js script is missing
endlocal & exit /B 1

:log_runner_missing
>> "%WRAPPER_LOG%" echo ERROR: Native log supervisor is missing
endlocal & exit /B 1
