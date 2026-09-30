param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [Parameter(Mandatory=$true)][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
$resultFolder = $null
$validInstall = $false
$installationTimedOut = $false
$result = @{ success = $false; version = $ExpectedVersion; error = $null; completedAt = $null; requiresAttention = $false }
try {
    if ($ExpectedVersion -notmatch '^\d{1,6}\.\d{1,6}\.\d{1,6}$' -or $ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid update version or checksum.' }
    $resolvedInstall = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $resolvedData = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
    if ((Get-Content -LiteralPath (Join-Path $resolvedInstall 'worktime-app.marker') -Raw).Trim() -ne 'MechMindWorktimeAssistant') { throw 'The installation marker is invalid.' }
    $validInstall = $true
    $resultFolder = Join-Path $resolvedData 'updates'
    $expectedFile = Join-Path $resultFolder "WorktimeAssistant-Setup-$ExpectedVersion.exe"
    if (-not [IO.Path]::GetFullPath($InstallerPath).Equals($expectedFile, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installer is outside the update directory.' }
    $stream = [IO.File]::OpenRead($expectedFile)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose(); $hasher.Dispose() }
    if ($actualHash -ne $ExpectedSha256) { throw 'The installer checksum changed. Installation stopped.' }
    # Allow the local service to return the installation acknowledgement first.
    Start-Sleep -Milliseconds 750
    $process = Start-Process -FilePath $expectedFile -ArgumentList @('/S', "/D=$resolvedInstall") -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(120000)) { $installationTimedOut = $true; throw 'Installation timed out. Please check the installation before retrying.' }
    if ($process.ExitCode -ne 0) { throw "Installation failed (exit $($process.ExitCode))." }
    if ((Get-Content -LiteralPath (Join-Path $resolvedInstall 'VERSION') -Raw).Trim() -ne $ExpectedVersion) { throw 'The installed version does not match the update.' }
    $result.success = $true
} catch {
    $result.error = $_.Exception.Message
} finally {
    $result.completedAt = [DateTime]::UtcNow.ToString('o')
    $result.requiresAttention = $installationTimedOut
    if ($resultFolder) {
        New-Item -ItemType Directory -Path $resultFolder -Force | Out-Null
        $resultPath = Join-Path $resultFolder 'install-result.json'
        $result | ConvertTo-Json | Set-Content -LiteralPath ($resultPath + '.tmp') -Encoding UTF8
        Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath -Force
    }
}
if ($validInstall -and -not $installationTimedOut -and (Test-Path -LiteralPath (Join-Path $resolvedInstall 'launcher.ps1'))) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + (Join-Path $resolvedInstall 'launcher.ps1') + '"')) -WindowStyle Hidden
}
if (-not $result.success) { exit 1 }
