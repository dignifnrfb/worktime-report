param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$diagnosticRoot = Join-Path $projectRoot "diagnostics"
$testRoot = Join-Path $diagnosticRoot ("installer-test-" + [guid]::NewGuid().ToString("N"))
$testId = "WorktimeRegression-" + [guid]::NewGuid().ToString("N")
$stage = Join-Path $projectRoot ".packaging-build\app"
$compiler = Join-Path $projectRoot ".packaging-tools\nsis-3.12\nsis-3.12\Bin\makensis.exe"
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = (Get-Command makensis -ErrorAction Stop).Source }
$installer = Join-Path $testRoot "WorktimeRegressionInstaller.exe"
$results = [System.Collections.Generic.List[string]]::new()
$driveLetter = $null
$servicePid = $null
$installedTargets = [System.Collections.Generic.List[string]]::new()
$succeeded = $false

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-Installer([string]$Target) {
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $Target)) -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw "Installer timed out." }
    return $process.ExitCode
}

function Invoke-Uninstaller([string]$Target) {
    $uninstaller = Join-Path $Target "uninstall.exe"
    if (-not (Test-Path -LiteralPath $uninstaller)) { return }
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw "Uninstaller timed out." }
    for ($attempt = 0; $attempt -lt 75; $attempt++) {
        if (-not (Test-Path -LiteralPath $uninstaller) -and
            -not (Test-Path -LiteralPath (Join-Path $Target "worktime-app.marker"))) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "Uninstaller did not remove the application marker."
}

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $testRoot "test-id.txt") -Value $testId -Encoding ASCII
try {
    Assert-True (Test-Path -LiteralPath (Join-Path $stage "worktime-common.cjs")) "Build the installer before running installer tests."
    $stageVersion = (Get-Content -LiteralPath (Join-Path $stage "VERSION") -Raw).Trim()
    Assert-True ($stageVersion -match '^\d+\.\d+\.\d+$') "The staged application version is invalid."
    Assert-True (Test-Path -LiteralPath (Join-Path $stage "user-guide.pdf")) "The current user guide is missing."
    $stageConfig = Get-Content -LiteralPath (Join-Path $stage "worktime.config.json") -Encoding UTF8 -Raw | ConvertFrom-Json
    Assert-True (-not $stageConfig.account) "The installer must not include a personal account."
    Assert-True (@($stageConfig.workdayOverrides.PSObject.Properties).Count -eq 0) "The installer must not include a personal calendar."
    $results.Add("Installer includes the user guide and no personal account or calendar")
    & $compiler '/V2' '/INPUTCHARSET' 'UTF8' "/DSTAGE=$stage" "/DOUTPUT=$installer" `
        "/DICON=$(Join-Path $projectRoot 'installer\assets\worktime.ico')" `
        "/DSTOP_SCRIPT=$(Join-Path $projectRoot 'installer\stop-service.ps1')" `
        "/DAPP_VERSION=$stageVersion" "/DAPP_ID=$testId" "/DAPP_NAME=$testId" `
        "/DDEFAULT_INSTALL_DIR=$(Join-Path $testRoot 'fallback')" `
        "/DCHECK_FILES=$(Join-Path $projectRoot '.packaging-build\check-files.nsh')" `
        "/DUNINSTALL_FILES=$(Join-Path $projectRoot '.packaging-build\uninstall-files.nsh')" `
        (Join-Path $projectRoot 'installer\worktime-assistant.nsi')
    Assert-True ($LASTEXITCODE -eq 0) "Test installer compilation failed."

    # A substituted drive maps only to this test's verified workspace directory.
    $driveDirectory = [System.IO.Path]::GetFullPath((Join-Path $testRoot "drive"))
    $testPrefix = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\') + '\'
    Assert-True ($driveDirectory.StartsWith($testPrefix, [System.StringComparison]::OrdinalIgnoreCase)) "Invalid test drive target."
    New-Item -ItemType Directory -Path (Join-Path $driveDirectory "runtime") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $driveDirectory "user-file.txt") -Value "keep-root" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $driveDirectory "runtime\user-file.txt") -Value "keep-runtime" -Encoding ASCII
    $driveLetter = @('Z','Y','X','W','V') | Where-Object { -not [System.IO.Directory]::Exists("${_}:\") } | Select-Object -First 1
    Assert-True ([bool]$driveLetter) "No free drive letter for the root-directory test."
    & "$env:WINDIR\System32\subst.exe" "${driveLetter}:" $driveDirectory
    Assert-True ($LASTEXITCODE -eq 0) "Unable to create the isolated test drive."
    $driveTarget = "${driveLetter}:\"
    $installedTargets.Add($driveTarget)
    Assert-True ((Invoke-Installer $driveTarget) -eq 0) "Installing at a drive root failed."
    Assert-True (Test-Path -LiteralPath (Join-Path $driveTarget "runtime\node.exe")) "Runtime was not installed at the drive root."
    $results.Add("Drive-root installation succeeds")
    Invoke-Uninstaller $driveTarget
    Assert-True ((Get-Content -LiteralPath (Join-Path $driveDirectory "user-file.txt") -Raw).Trim() -eq "keep-root") "Uninstall removed an unrelated root file."
    Assert-True ((Get-Content -LiteralPath (Join-Path $driveDirectory "runtime\user-file.txt") -Raw).Trim() -eq "keep-runtime") "Uninstall removed an unrelated nested file."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $driveDirectory "runtime\node.exe"))) "Uninstall left the application runtime."
    $results.Add("Uninstall preserves unrelated files at the root and inside shared folders")

    $collisionRoot = Join-Path $testRoot "existing-files"
    New-Item -ItemType Directory -Path $collisionRoot | Out-Null
    Set-Content -LiteralPath (Join-Path $collisionRoot "launcher.ps1") -Value "user-owned" -Encoding ASCII
    Assert-True ((Invoke-Installer $collisionRoot) -ne 0) "Installer should reject existing unrelated files."
    Assert-True ((Get-Content -LiteralPath (Join-Path $collisionRoot "launcher.ps1") -Raw).Trim() -eq "user-owned") "Installer overwrote an existing file."
    $results.Add("Fresh installation refuses to overwrite existing unrelated files")

    $chineseName = -join @([char]0x5DE5, [char]0x65F6)
    $spaceRoot = Join-Path $testRoot ("Space Folder " + $chineseName)
    $installedTargets.Add($spaceRoot)
    Assert-True ((Invoke-Installer $spaceRoot) -eq 0) "Installing in a path containing spaces and Chinese characters failed."
    Assert-True (Test-Path -LiteralPath (Join-Path $spaceRoot "worktime-common.cjs")) "Shared runtime module is missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $spaceRoot "worktime-log.cjs")) "Logging module is missing."
    $results.Add("Installation supports spaces and Chinese characters")

    # Exercise the shipped launcher on a temporary port. The wrapper records the
    # browser-open request instead of opening a user's browser or any OA page.
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $launcherPath = Join-Path $spaceRoot "launcher.ps1"
    $launcher = Get-Content -LiteralPath $launcherPath -Encoding UTF8 -Raw
    $launcher = $launcher.Replace('http://127.0.0.1:3089/', "http://127.0.0.1:$port/").Replace('"3089"', ('"' + $port + '"'))
    $launcher = $launcher.Replace('Show-LaunchError $_.Exception.Message', '[Console]::Error.WriteLine($_.Exception.Message)')
    Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding UTF8
    $wrapper = Join-Path $testRoot "launch-wrapper.ps1"
    $probeFile = Join-Path $testRoot "launch-probe.txt"
    $fakeLocalData = Join-Path $testRoot "isolated-localdata"
    @'
param([string]$Launcher, [string]$LocalData, [string]$ProbeFile)
$env:LOCALAPPDATA = $LocalData
$env:WORKTIME_DISABLE_UPDATE_CHECK = '1'
function Start-Process {
    param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle, [string]$RedirectStandardOutput, [string]$RedirectStandardError)
    if ($FilePath.StartsWith('http://127.0.0.1:')) {
        Set-Content -LiteralPath $ProbeFile -Value $FilePath -Encoding ASCII
        return
    }
    $child = Microsoft.PowerShell.Management\Start-Process @PSBoundParameters -PassThru
    Set-Content -LiteralPath ($ProbeFile + '.pid') -Value $child.Id -Encoding ASCII
}
. $Launcher
'@ | Set-Content -LiteralPath $wrapper -Encoding UTF8
    $launchArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $wrapper + '"'),'-Launcher',('"' + $launcherPath + '"'),'-LocalData',('"' + $fakeLocalData + '"'),'-ProbeFile',('"' + $probeFile + '"'))
    $launchProcess = Start-Process -FilePath powershell.exe -ArgumentList $launchArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $testRoot "launch-errors.log")
    $null = $launchProcess.Handle
    Assert-True ($launchProcess.WaitForExit(30000)) "Launcher timed out in a spaced path."
    if (Test-Path -LiteralPath ($probeFile + '.pid')) { $servicePid = [int](Get-Content -LiteralPath ($probeFile + '.pid') -Raw) }
    if ($launchProcess.ExitCode -ne 0) { throw (Get-Content -LiteralPath (Join-Path $testRoot "launch-errors.log") -Raw) }
    Assert-True (Test-Path -LiteralPath $probeFile) "Launcher did not request opening the dashboard."
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    Assert-True ($health.app -eq 'MechMindWorktimeAssistant' -and $health.installRoot -eq $spaceRoot) "Launcher connected to the wrong service."
    Assert-True ($health.dataRoot.StartsWith($fakeLocalData, [System.StringComparison]::OrdinalIgnoreCase)) "Launcher did not isolate test data."
    $results.Add("Shipped launcher starts successfully from a spaced Chinese path")

    $dataConfigPath = Join-Path $health.dataRoot "worktime.config.json"
    # A fresh account has in-memory defaults until login or its first saved change.
    $dataConfig = Get-Content -LiteralPath (Join-Path $spaceRoot "worktime.config.json") -Encoding UTF8 -Raw | ConvertFrom-Json
    $testAccount = @{ name = 'Installer Test'; employeeNo = 'INSTALLER-TEST' }
    $dataConfig | Add-Member -NotePropertyName account -NotePropertyValue $testAccount -Force
    $dataConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $dataConfigPath -Encoding UTF8
    $calendarBody = @{ account = $testAccount; dates = @('2020-01-04'); mode = 'work' } | ConvertTo-Json -Depth 3
    $calendar = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/calendar" -Method Post -ContentType 'application/json' -Body $calendarBody
    Assert-True ($calendar.dashboard.workdayOverrides.'2020-01-04' -eq 'work') "The installed calendar API did not save weekend work."
    $savedConfig = Get-Content -LiteralPath $dataConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
    Assert-True ($savedConfig.workdayOverrides.'2020-01-04' -eq 'work') "The installed calendar update was not persisted."
    $calendarBody = @{ account = $testAccount; dates = @('2020-01-04'); mode = 'default' } | ConvertTo-Json -Depth 3
    $calendar = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/calendar" -Method Post -ContentType 'application/json' -Body $calendarBody
    Assert-True (@($calendar.dashboard.workdayOverrides.PSObject.Properties).Count -eq 0) "Restoring the installed calendar default failed."
    Assert-True (Test-Path -LiteralPath (Join-Path $spaceRoot "user-guide.pdf")) "The user guide was not installed."
    $results.Add("Installed calendar API saves and restores overrides in isolated account data")

    # Simulate an older install, then cover-install the staged release. All data
    # is under fakeLocalData; use a local unreachable OA URL so no real OA is contacted.
    $upgradeConfig = Get-Content -LiteralPath $dataConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $upgradeConfig.baseUrl = 'http://127.0.0.1:9'
    $upgradeConfig.hours = '6.5'
    $upgradeConfig.remark = 'upgrade-preserve-test'
    $upgradeConfig.workType = @{ code = '004'; name = (-join @([char]0x4F11, [char]0x5047)) }
    $upgradeConfig.projectCode = ''
    $upgradeConfig.projectId = ''
    $upgradeConfig.projectName = ''
    $upgradeConfig.workdayOverrides = @{ '2020-01-04' = 'work' }
    $upgradeConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $dataConfigPath -Encoding UTF8
    $statePath = Join-Path $health.dataRoot 'storage-state.json'
    Set-Content -LiteralPath $statePath -Value '{"cookies":[],"origins":[]}' -Encoding UTF8
    $accountArchive = Join-Path $health.dataRoot 'accounts\upgrade-test'
    New-Item -ItemType Directory -Path $accountArchive -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $accountArchive 'worktime.config.json') -Value '{"remark":"preserve-archive"}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $health.dataRoot 'projects.json') -Value '{"projects":[],"sourceTotal":0}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $health.dataRoot 'work-types.json') -Value '{"workTypes":[],"sourceTotal":0}' -Encoding UTF8
    $csvName = (-join @([char]0x5DF2, [char]0x529E, [char]0x5DE5, [char]0x65F6)) + '.csv'
    Set-Content -LiteralPath (Join-Path $health.dataRoot $csvName) -Value 'preserve-cached-records' -Encoding UTF8
    $preservedFiles = @($dataConfigPath, $statePath, (Join-Path $accountArchive 'worktime.config.json'),
        (Join-Path $health.dataRoot 'projects.json'), (Join-Path $health.dataRoot 'work-types.json'), (Join-Path $health.dataRoot $csvName))
    $beforeUpgrade = @{}
    foreach ($file in $preservedFiles) { $beforeUpgrade[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
    Set-Content -LiteralPath (Join-Path $spaceRoot 'VERSION') -Value '1.2.6' -Encoding ASCII
    Assert-True ((Invoke-Installer $spaceRoot) -eq 0) 'Cover-install upgrade failed.'
    foreach ($file in $preservedFiles) {
        Assert-True ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $beforeUpgrade[$file]) "Upgrade changed user data: $file"
    }
    Assert-True ((Get-Content -LiteralPath (Join-Path $spaceRoot 'VERSION') -Raw).Trim() -eq $stageVersion) 'Upgrade did not replace VERSION.'
    Assert-True (Test-Path -LiteralPath (Join-Path $spaceRoot 'worktime-progress.cjs')) 'Upgrade omitted the progress module.'
    Assert-True (Test-Path -LiteralPath (Join-Path $spaceRoot 'worktime-update.cjs')) 'Upgrade omitted the update module.'
    Assert-True (Test-Path -LiteralPath (Join-Path $spaceRoot 'apply-update.ps1')) 'Upgrade omitted the update helper.'
    Assert-True (Test-Path -LiteralPath (Join-Path $spaceRoot 'update-source.json')) 'Upgrade omitted the update source.'
    $results.Add('Cover-install from an older version preserves session, defaults, calendar, caches and account archives')

    # Restart the upgraded launcher on the same isolated test port.
    Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding UTF8
    $launchProcess = Start-Process -FilePath powershell.exe -ArgumentList $launchArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $testRoot 'launch-errors.log')
    $null = $launchProcess.Handle
    Assert-True ($launchProcess.WaitForExit(30000) -and $launchProcess.ExitCode -eq 0) 'Upgraded launcher did not start.'
    $servicePid = [int](Get-Content -LiteralPath ($probeFile + '.pid') -Raw)
    $upgraded = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/dashboard" -TimeoutSec 3
    Assert-True ($upgraded.update.currentVersion -eq $stageVersion -and $upgraded.update.canInstall -eq $true) 'Upgrade did not expose installed update status.'
    Assert-True ($upgraded.defaults.hours -eq '6.5' -and $upgraded.defaults.workType.code -eq '004' -and $upgraded.defaults.projectCode -eq '') 'Upgrade lost leave defaults.'
    Assert-True ($upgraded.workdayOverrides.'2020-01-04' -eq 'work' -and $null -eq $upgraded.batchProgress) 'Upgrade lost calendar settings or restored an old batch.'
    $results.Add('Upgraded app opens with preserved leave defaults and calendar and no resumed batch')

    $relocatedRoot = Join-Path $testRoot "relocated"
    $installedTargets.Add($relocatedRoot)
    Assert-True ((Invoke-Installer $relocatedRoot) -eq 0) "Installing to a new directory failed."
    Start-Sleep -Milliseconds 400
    Assert-True (-not (Get-Process -Id $servicePid -ErrorAction SilentlyContinue)) "Relocation left the previous service running."
    $servicePid = $null
    $results.Add("Changing installation directory stops the previous installation's service")
    Invoke-Uninstaller $relocatedRoot
    Invoke-Uninstaller $spaceRoot
    $results.Add("Both installation directories can be uninstalled after relocation")

    # Mock process enumeration to verify sibling directories and other programs
    # on the same root drive are never targeted by stop-service.ps1.
    & {
        $capturedStops = [System.Collections.Generic.List[int]]::new()
        function Get-CimInstance { param($ClassName, $Filter)
            @(
                [pscustomobject]@{ExecutablePath='C:\TestApp\runtime\node.exe'; ProcessId=101},
                [pscustomobject]@{ExecutablePath='C:\TestAppOther\runtime\node.exe'; ProcessId=102},
                [pscustomobject]@{ExecutablePath='C:\TestApp\other\node.exe'; ProcessId=103}
            )
        }
        function Stop-Process { param($Id, [switch]$Force) $capturedStops.Add($Id) }
        & (Join-Path $projectRoot 'installer\stop-service.ps1') -InstallRoot 'C:\TestApp'
        Assert-True ($capturedStops.Count -eq 1 -and $capturedStops[0] -eq 101) "Service stop targeted another Node runtime."
    }
    $results.Add("Stopping the service leaves sibling applications and other runtimes alone")
    $succeeded = $true
    [pscustomobject]@{completedAt=(Get-Date).ToString('o'); version=$stageVersion; isolatedAppId=$testId; passed=$results.Count; checks=@($results)} |
        ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $diagnosticRoot "installer-regression.json") -Encoding UTF8
    $results | ForEach-Object { Write-Output "PASS: $_" }
} finally {
    if ($servicePid) {
        $ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction SilentlyContinue
        if ($ownedProcess.ExecutablePath -and $ownedProcess.ExecutablePath.StartsWith([System.IO.Path]::GetFullPath($testRoot).TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            Stop-Process -Id $servicePid -Force -ErrorAction SilentlyContinue
        }
    }
    if ($driveLetter) { & "$env:WINDIR\System32\subst.exe" "${driveLetter}:" /D }
    if ($succeeded) {
        $resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
        $diagnosticPrefix = [System.IO.Path]::GetFullPath($diagnosticRoot).TrimEnd('\') + '\'
        Assert-True ($resolvedTest.StartsWith($diagnosticPrefix, [System.StringComparison]::OrdinalIgnoreCase)) "Invalid test cleanup target."
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force
    } else {
        Write-Output "Failed test artifacts retained at: $testRoot"
    }
}
