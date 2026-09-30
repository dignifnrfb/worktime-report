$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dashboardRoot = Join-Path $projectRoot "dashboard"
$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$bundledNode = Join-Path $runtimeRoot "node\bin\node.exe"
$systemNode = Get-Command node -ErrorAction SilentlyContinue
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($systemNode) { $systemNode.Source } else { $null }
$dataRoot = Join-Path $env:LOCALAPPDATA "MechMindWorktimeAssistant"
$logRoot = Join-Path $dataRoot "logs"
$server = Join-Path $projectRoot "dashboard-server.cjs"
$appUrl = "http://127.0.0.1:3088/"

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Test-App {
    try {
        $response = Invoke-RestMethod -Uri "${appUrl}health" -TimeoutSec 1
        return $response.ok -eq $true -and $response.app -eq "MechMindWorktimeAssistant" -and
            $response.installRoot -eq [System.IO.Path]::GetFullPath($projectRoot)
    } catch {
        return $false
    }
}

if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    throw "Node.js 22 or newer is required. Install Node.js, then launch this file again."
}
if (-not (Test-Path -LiteralPath (Join-Path $dashboardRoot "node_modules\playwright"))) {
    throw "Dashboard dependencies are missing. Copy the complete project folder before launching."
}

$nodeMajor = [int](& $node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required." }

$localNodeModules = Join-Path $dashboardRoot "node_modules"
$bundledNodeModules = Join-Path $runtimeRoot "node\node_modules"
$env:NODE_PATH = if (Test-Path -LiteralPath $bundledNodeModules) { "$localNodeModules;$bundledNodeModules" } else { $localNodeModules }
$env:WORKTIME_DATA_ROOT = $dataRoot
$env:WORKTIME_STATIC_ROOT = Join-Path $dashboardRoot "portable-dist"
$env:WORKTIME_DASHBOARD_PORT = "3088"

if (-not (Test-Path -LiteralPath (Join-Path $env:WORKTIME_STATIC_ROOT "index.html"))) {
    Push-Location $dashboardRoot
    try {
        & $node (Join-Path $dashboardRoot "node_modules\vite\bin\vite.js") build --config portable.vite.config.ts
        if ($LASTEXITCODE -ne 0) { throw "Dashboard build failed." }
    } finally {
        Pop-Location
    }
}

if (-not (Test-App)) {
    Start-Process `
        -FilePath $node `
        -ArgumentList @('"' + $server + '"') `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logRoot "service.out.log") `
        -RedirectStandardError (Join-Path $logRoot "crash.err.log")
}

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-App) {
        Start-Process $appUrl
        exit 0
    }
    Start-Sleep -Milliseconds 300
}

throw "Dashboard startup timed out. Check logs in $logRoot."
