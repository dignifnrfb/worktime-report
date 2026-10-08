param(
    [string]$Version = "1.3.2",
    [string]$GitHubRepository = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$dashboardRoot = Join-Path $projectRoot "dashboard"
$releaseRoot = Join-Path $projectRoot "release"
$buildRoot = Join-Path $projectRoot ".packaging-build"
$appRoot = Join-Path $buildRoot "app"
$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node"
$bundledNode = Join-Path $runtimeRoot "bin\node.exe"
$systemNode = Get-Command node -ErrorAction SilentlyContinue
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($systemNode) { $systemNode.Source } else { $null }
$vite = Join-Path $dashboardRoot "node_modules\vite\bin\vite.js"
$playwrightRoot = Join-Path $dashboardRoot "node_modules\.pnpm\playwright@1.62.0\node_modules\playwright"
$playwrightCoreRoot = Join-Path $dashboardRoot "node_modules\.pnpm\playwright-core@1.62.0\node_modules\playwright-core"
$parse5Root = Join-Path $dashboardRoot "node_modules\.pnpm\parse5@7.3.0\node_modules\parse5"
$entitiesRoot = Join-Path $dashboardRoot "node_modules\.pnpm\entities@6.0.1\node_modules\entities"
$iconSource = Join-Path $PSScriptRoot "assets\worktime-icon-source.png"
$iconPath = Join-Path $PSScriptRoot "assets\worktime.ico"
$webIconPath = Join-Path $dashboardRoot "public\worktime-icon.png"
$guideFiles = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot "output\pdf") -Filter '*.pdf' -File)
if ($guideFiles.Count -ne 1) { throw "Expected one current PDF user guide in output/pdf." }
$guidePath = $guideFiles[0].FullName
$nsiPath = Join-Path $PSScriptRoot "worktime-assistant.nsi"
$stopScript = Join-Path $PSScriptRoot "stop-service.ps1"
$portableNsis = Join-Path $projectRoot ".packaging-tools\nsis-3.12\nsis-3.12\Bin\makensis.exe"
$systemNsis = Get-Command makensis -ErrorAction SilentlyContinue
$makensis = if (Test-Path -LiteralPath $portableNsis) { $portableNsis } elseif ($systemNsis) { $systemNsis.Source } else { $null }

if (-not $node -or -not (Test-Path -LiteralPath $node)) { throw "Node.js was not found for packaging." }
if (-not $makensis -or -not (Test-Path -LiteralPath $makensis)) { throw "NSIS compiler was not found for packaging." }
foreach ($required in @($vite, $playwrightRoot, $playwrightCoreRoot, $parse5Root, $entitiesRoot, $iconSource, $nsiPath, $stopScript)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing packaging input: $required" }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must use major.minor.patch format." }
if ($GitHubRepository -and $GitHubRepository -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$') { throw "GitHubRepository must use owner/repository format." }

$resolvedProject = [System.IO.Path]::GetFullPath($projectRoot)
$resolvedBuild = [System.IO.Path]::GetFullPath($buildRoot)
if (-not $resolvedBuild.Equals((Join-Path $resolvedProject ".packaging-build"), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The packaging work directory is invalid."
}
if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $webIconPath) -Force | Out-Null

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "make-icon.ps1") -Source $iconSource -IconOutput $iconPath -PngOutput $webIconPath
if ($LASTEXITCODE -ne 0) { throw "Application icon generation failed." }

Push-Location $dashboardRoot
try {
    & $node $vite build --config portable.vite.config.ts
    if ($LASTEXITCODE -ne 0) { throw "The portable dashboard build failed." }
} finally {
    Pop-Location
}
Copy-Item -LiteralPath $webIconPath -Destination (Join-Path $dashboardRoot "portable-dist\worktime-icon.png") -Force

New-Item -ItemType Directory -Path (Join-Path $appRoot "runtime") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appRoot "node_modules") -Force | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $appRoot "runtime\node.exe")
Copy-Item -LiteralPath (Join-Path $projectRoot "dashboard-server.cjs") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "worktime.cjs") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "worktime-common.cjs") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "worktime-log.cjs") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "worktime-api.cjs") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "worktime-progress.cjs") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "worktime-update.cjs") -Destination $appRoot
if ($GitHubRepository) {
    @{ repository = $GitHubRepository } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appRoot "update-source.json") -Encoding UTF8
} else {
    Copy-Item -LiteralPath (Join-Path $projectRoot "update-source.json") -Destination $appRoot
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "apply-update.ps1") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "default-worktime.config.json") -Destination (Join-Path $appRoot "worktime.config.json")
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "launcher.ps1") -Destination $appRoot
Copy-Item -LiteralPath $stopScript -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "PRIVACY.txt") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "THIRD-PARTY-NOTICES.txt") -Destination $appRoot
Copy-Item -LiteralPath $iconPath -Destination (Join-Path $appRoot "worktime.ico")
Copy-Item -LiteralPath $guidePath -Destination (Join-Path $appRoot "user-guide.pdf")
Copy-Item -LiteralPath (Join-Path $dashboardRoot "portable-dist") -Destination (Join-Path $appRoot "public") -Recurse
Copy-Item -LiteralPath $playwrightRoot -Destination (Join-Path $appRoot "node_modules\playwright") -Recurse
Copy-Item -LiteralPath $playwrightCoreRoot -Destination (Join-Path $appRoot "node_modules\playwright-core") -Recurse
Copy-Item -LiteralPath $parse5Root -Destination (Join-Path $appRoot "node_modules\parse5") -Recurse
Copy-Item -LiteralPath $entitiesRoot -Destination (Join-Path $appRoot "node_modules\entities") -Recurse
Copy-Item -LiteralPath (Join-Path $playwrightRoot "LICENSE") -Destination (Join-Path $appRoot "PLAYWRIGHT-LICENSE.txt")
Set-Content -LiteralPath (Join-Path $appRoot "VERSION") -Value $Version -Encoding ASCII
Set-Content -LiteralPath (Join-Path $appRoot "worktime-app.marker") -Value "MechMindWorktimeAssistant" -Encoding ASCII

$installerName = "WorktimeAssistant-Setup-$Version.exe"
$installerPath = Join-Path $releaseRoot $installerName
$temporaryInstaller = Join-Path $buildRoot $installerName
$checkFilesPath = Join-Path $buildRoot "check-files.nsh"
$uninstallFilesPath = Join-Path $buildRoot "uninstall-files.nsh"
$appPrefix = [System.IO.Path]::GetFullPath($appRoot).TrimEnd('\') + '\'
$checkLines = [System.Collections.Generic.List[string]]::new()
$uninstallLines = [System.Collections.Generic.List[string]]::new()
function ConvertTo-NsisLiteral([string]$Value) {
    return $Value.Replace('$', '$$').Replace('"', '$\"')
}
foreach ($file in Get-ChildItem -LiteralPath $appRoot -File -Recurse) {
    $relative = ConvertTo-NsisLiteral $file.FullName.Substring($appPrefix.Length)
    $checkLines.Add('IfFileExists "$INSTDIR\' + $relative + '" 0 +3')
    $checkLines.Add('StrCpy $9 "' + $relative + '"')
    $checkLines.Add('Goto install_collision')
    $uninstallLines.Add('Delete "$INSTDIR\' + $relative + '"')
}
$checkLines.Add('IfFileExists "$INSTDIR\uninstall.exe" 0 +3')
$checkLines.Add('StrCpy $9 "uninstall.exe"')
$checkLines.Add('Goto install_collision')
foreach ($directory in Get-ChildItem -LiteralPath $appRoot -Directory -Recurse | Sort-Object { $_.FullName.Length } -Descending) {
    $relative = ConvertTo-NsisLiteral $directory.FullName.Substring($appPrefix.Length)
    $uninstallLines.Add('RMDir "$INSTDIR\' + $relative + '"')
}
Set-Content -LiteralPath $checkFilesPath -Value $checkLines -Encoding UTF8
Set-Content -LiteralPath $uninstallFilesPath -Value $uninstallLines -Encoding UTF8

& $makensis "/INPUTCHARSET" "UTF8" "/DSTAGE=$appRoot" "/DOUTPUT=$temporaryInstaller" "/DICON=$iconPath" "/DSTOP_SCRIPT=$stopScript" "/DAPP_VERSION=$Version" "/DCHECK_FILES=$checkFilesPath" "/DUNINSTALL_FILES=$uninstallFilesPath" $nsiPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryInstaller)) {
    throw "The Windows installer could not be generated."
}

# Keep the previous installer until the new build succeeds; preserve unrelated release files.
$archiveRoot = Join-Path $projectRoot "backups\installers"
New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
$releasePrefix = [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
$archivePrefix = [System.IO.Path]::GetFullPath($archiveRoot).TrimEnd('\') + '\'
foreach ($oldFile in Get-ChildItem -LiteralPath $releaseRoot -File) {
    if ($oldFile.Name -notmatch '^WorktimeAssistant-Setup-\d+\.\d+\.\d+\.exe$') { continue }
    $source = [System.IO.Path]::GetFullPath($oldFile.FullName)
    $destination = [System.IO.Path]::GetFullPath((Join-Path $archiveRoot ($oldFile.BaseName + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.exe')))
    if (-not $source.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $destination.StartsWith($archivePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Invalid installer archive path."
    }
    Move-Item -LiteralPath $source -Destination $destination
}
Copy-Item -LiteralPath $temporaryInstaller -Destination $installerPath

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash
Set-Content -LiteralPath ($installerPath + '.sha256') -Value ($hash.ToLowerInvariant() + ' *' + $installerName) -Encoding ASCII
Write-Output "INSTALLER=$installerPath"
Write-Output "SHA256=$hash"
