param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicationRoot = Join-Path $projectRoot 'publication'
$sourceRoot = Join-Path $publicationRoot ('source-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
# An explicit allowlist is required: the working directory contains live personal data.
$files = @(
  'VERSION', 'update-source.json', '.gitignore', '.github\workflows\release.yml',
  'dashboard-server.cjs', 'worktime.cjs', 'worktime-api.cjs', 'worktime-common.cjs',
  'worktime-log.cjs', 'worktime-progress.cjs', 'worktime-update.cjs',
  '启动工时面板.cmd', '启动工时面板.ps1',
  'dashboard\package.json', 'dashboard\pnpm-lock.yaml', 'dashboard\pnpm-workspace.yaml', 'dashboard\tsconfig.json',
  'dashboard\tsconfig.portable.json', 'dashboard\eslint.config.mjs',
  'dashboard\postcss.config.mjs', 'dashboard\portable.vite.config.ts',
  'dashboard\portable\main.tsx', 'dashboard\portable\index.html',
  'dashboard\app\page.tsx', 'dashboard\app\globals.css', 'dashboard\public\worktime-icon.png',
  'output\pdf\工时助手使用说明.pdf', 'release-notes\1.3.0.md',
  'publishing\README.md', 'publishing\prepare-source.ps1'
)
$files += @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'installer') -File -Recurse | ForEach-Object { $_.FullName.Substring($projectRoot.Length + 1) })
$files += @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -File | Where-Object { $_.Name -match '\.test\.(cjs|ps1)$|^test-support\.cjs$' } | ForEach-Object { $_.FullName.Substring($projectRoot.Length + 1) })
$manifest = [Collections.Generic.List[object]]::new()
foreach ($relative in $files) {
  $inputFile = Join-Path $projectRoot $relative
  if (-not (Test-Path -LiteralPath $inputFile -PathType Leaf)) { throw "Missing publication input: $relative" }
  $targetFile = Join-Path $sourceRoot $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $targetFile) -Force | Out-Null
  Copy-Item -LiteralPath $inputFile -Destination $targetFile
  $manifest.Add(@{ path = $relative.Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash })
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $sourceRoot 'README.md')
$manifest.Add(@{ path = 'README.md'; sha256 = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'README.md') -Algorithm SHA256).Hash })
@{ createdAt = [DateTime]::UtcNow.ToString('o'); sourceRoot = $sourceRoot; files = @($manifest) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $publicationRoot 'source-manifest.json') -Encoding UTF8
Write-Output "SOURCE=$sourceRoot"
Write-Output "FILES=$($manifest.Count)"
