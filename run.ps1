param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5500
)

$ErrorActionPreference = 'Stop'

# Paths
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RootDir 'backend'
$FrontendDir = Join-Path $RootDir 'frontend'
$VenvDir = Join-Path $BackendDir '.venv'
$LogDir = Join-Path $RootDir 'logs'

Write-Host "AI Traffic Control System - Windows launcher" -ForegroundColor Cyan

# Resolve Python launcher properly (handle 'py -3' vs 'python')
$pyCmd = $null
$pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
    try {
        & py -3 --version *>$null
        if ($LASTEXITCODE -eq 0) {
            $pyCmd = 'py'
            $pyArgs = @('-3')
        }
    } catch {}
}
if (-not $pyCmd) {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $pyCmd = 'python'
        $pyArgs = @()
    }
}
if (-not $pyCmd) {
    Write-Error "Python 3 is required. Install from https://www.python.org/downloads/ and retry."
    exit 1
}

# Create venv if missing (or if python.exe not present)
if (-not (Test-Path $VenvDir)) {
    Write-Host "Creating virtual environment in $VenvDir" -ForegroundColor Yellow
    & $pyCmd @pyArgs -m venv $VenvDir
}

$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
    Write-Host "Virtual environment missing or corrupt. Recreating..." -ForegroundColor Yellow
    if (Test-Path $VenvDir) { Remove-Item -Recurse -Force $VenvDir }
    & $pyCmd @pyArgs -m venv $VenvDir
}
if (-not (Test-Path $VenvPython)) {
    Write-Error "Failed to create virtual environment at $VenvDir"
    exit 1
}

# Install backend dependencies using python -m pip (more reliable than pip.exe)
Write-Host "Installing backend requirements..." -ForegroundColor Yellow
& $VenvPython -m pip install --upgrade pip *>$null
& $VenvPython -m pip install -r (Join-Path $BackendDir 'requirements.txt')

# Build commands
$BackendCmd = "`"$VenvPython`" -m uvicorn app:app --reload --port $BackendPort"
$FrontendCmd = "`"$VenvPython`" -m http.server $FrontendPort"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$BackendLog = Join-Path $LogDir 'backend.log'
$FrontendLog = Join-Path $LogDir 'frontend.log'

# If running inside VS Code terminal, keep processes inside by using background jobs
$insideVSCode = ($env:TERM_PROGRAM -eq 'vscode') -or ($env:VSCODE_PID)
if ($insideVSCode) {
    Write-Host "Running inside VS Code terminal: starting background jobs" -ForegroundColor DarkCyan

    Write-Host "Starting backend on http://127.0.0.1:$BackendPort ..." -ForegroundColor Green
    $backendJob = Start-Job -Name 'traffic-backend' -ScriptBlock {
        param($dir,$python,$port,$log)
        Set-Location $dir
        & $python -m uvicorn app:app --reload --port $port 2>&1 | Tee-Object -FilePath $log -Append
    } -ArgumentList $BackendDir,$VenvPython,$BackendPort,$BackendLog

    Write-Host "Starting frontend on http://127.0.0.1:$FrontendPort ..." -ForegroundColor Green
    $frontendJob = Start-Job -Name 'traffic-frontend' -ScriptBlock {
        param($dir,$python,$port,$log)
        Set-Location $dir
        & $python -m http.server $port 2>&1 | Tee-Object -FilePath $log -Append
    } -ArgumentList $FrontendDir,$VenvPython,$FrontendPort,$FrontendLog

    Write-Host "Jobs started: backend JobId=$($backendJob.Id), frontend JobId=$($frontendJob.Id)" -ForegroundColor DarkGray
    Write-Host "View logs: Get-Content `"$BackendLog`" -Wait | Get-Content `"$FrontendLog`" -Wait" -ForegroundColor DarkGray
    Write-Host "Stop: Stop-Job -Name traffic-backend,traffic-frontend ; Remove-Job -Name traffic-*" -ForegroundColor DarkGray
} else {
    # Fallback: open external windows when not inside VS Code terminal
    Write-Host "Starting backend on http://127.0.0.1:$BackendPort ..." -ForegroundColor Green
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-NoExit',
        '-Command', "Set-Location `"$BackendDir`"; $BackendCmd"
    ) -WindowStyle Normal

    Write-Host "Starting frontend on http://127.0.0.1:$FrontendPort ..." -ForegroundColor Green
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-NoExit',
        '-Command', "Set-Location `"$FrontendDir`"; $FrontendCmd"
    ) -WindowStyle Normal
}

Write-Host "`nAll set!" -ForegroundColor Cyan
Write-Host "Open the frontend: http://127.0.0.1:$FrontendPort" -ForegroundColor Cyan
Write-Host "Backend health:     http://127.0.0.1:$BackendPort/health" -ForegroundColor Cyan
