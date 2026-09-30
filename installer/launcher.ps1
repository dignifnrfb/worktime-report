$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataRoot = Join-Path $env:LOCALAPPDATA "MechMindWorktimeAssistant"
$logRoot = Join-Path $dataRoot "logs"
$node = Join-Path $appRoot "runtime\node.exe"
$server = Join-Path $appRoot "dashboard-server.cjs"
$staticRoot = Join-Path $appRoot "public"
$appUrl = "http://127.0.0.1:3089/"

function Show-LaunchError([string]$Message) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        $Message,
        "Worktime Assistant",
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
}

function Test-App {
    try {
        $response = Invoke-RestMethod -Uri "${appUrl}health" -TimeoutSec 1
        return $response.ok -eq $true -and $response.app -eq "MechMindWorktimeAssistant" -and
            $response.installRoot -eq [System.IO.Path]::GetFullPath($appRoot)
    } catch {
        return $false
    }
}

try {
    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $server)) {
        throw "The installation is incomplete. Please run the installer again."
    }

    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $env:WORKTIME_DATA_ROOT = $dataRoot
    $env:WORKTIME_STATIC_ROOT = $staticRoot
    $env:WORKTIME_DASHBOARD_PORT = "3089"
    $env:WORKTIME_LAUNCHER_MANAGED = "1"
    $env:NODE_PATH = Join-Path $appRoot "node_modules"

    if (-not (Test-App)) {
        Start-Process `
            -FilePath $node `
            -ArgumentList @('"' + $server + '"') `
            -WorkingDirectory $appRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logRoot "installed-service.out.log") `
            -RedirectStandardError (Join-Path $logRoot "crash.err.log")
    }

    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (Test-App) {
            if ($env:WORKTIME_DISABLE_UPDATE_CHECK -ne "1") {
                try { Invoke-RestMethod -Uri "${appUrl}api/updates/check" -Method Post -ContentType "application/json" -Body '{}' -TimeoutSec 2 | Out-Null } catch { }
            }
            Start-Process $appUrl
            exit 0
        }
        Start-Sleep -Milliseconds 250
    }

    throw "Startup timed out. Please retry or check whether security software blocked the app."
} catch {
    Show-LaunchError $_.Exception.Message
    exit 1
}
