param(
    [Parameter(Mandatory = $true)][string]$InstallRoot
)

$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$expectedNode = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot "runtime\node.exe"))
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ExecutablePath -and
        [System.IO.Path]::GetFullPath($_.ExecutablePath).Equals(
            $expectedNode,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
