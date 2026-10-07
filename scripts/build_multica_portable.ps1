[CmdletBinding()]
param([string]$Version = 'current')
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DistRoot = Join-Path $RepoRoot 'dist'
$PackageName = 'Multica-Control-Console-' + $Version
$PackageRoot = Join-Path $DistRoot $PackageName
$ZipPath = Join-Path $DistRoot ($PackageName + '.zip')
$DesktopProject = Join-Path $RepoRoot 'desktop\Multica.Desktop.csproj'
$DesktopPublishRoot = Join-Path $env:TEMP ('Multica-Desktop-Publish-' + $Version + '-' + [guid]::NewGuid().ToString('N'))
if (-not (Test-Path -LiteralPath $DesktopProject)) { throw '缺少桌面主程序项目：desktop\Multica.Desktop.csproj' }
$dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnet) { throw '构建桌面 EXE 需要 .NET SDK。' }
if (-not (Test-Path -LiteralPath $DistRoot)) { New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null }
$distResolved = (Resolve-Path -LiteralPath $DistRoot).Path
if (Test-Path -LiteralPath $PackageRoot) {
  $candidate = (Resolve-Path -LiteralPath $PackageRoot).Path
  if (-not $candidate.StartsWith($distResolved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove a path outside dist.' }
  # A previously launched portable directory may be an installation, not build cache.
  foreach ($protected in @('config','runtime\browser-profile','runtime\webview-profile','mj-automation\run','mj-automation\output','mj-automation\archive','mj-automation\receipts')) {
    $protectedPath = Join-Path $candidate $protected
    if (Test-Path -LiteralPath $protectedPath) {
      $userFiles = @(Get-ChildItem -LiteralPath $protectedPath -File -Recurse -Force | Where-Object { $_.Name -notin @('README.txt','README.md','local.ps1.example') })
      if ($userFiles.Count -gt 0) { throw '目标便携目录已有本机资料，拒绝覆盖；请使用新的 Version 构建到新目录。' }
    }
  }
  Remove-Item -LiteralPath $candidate -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
New-Item -ItemType Directory -Force -Path $PackageRoot | Out-Null
& $dotnet.Source publish $DesktopProject --configuration Release --runtime win-x64 --self-contained true --output $DesktopPublishRoot -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true --nologo
if ($LASTEXITCODE -ne 0) { throw ('桌面 EXE 构建失败：' + $LASTEXITCODE) }
New-Item -ItemType Directory -Force -Path $PackageRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $DesktopPublishRoot 'Multica.exe') -Destination (Join-Path $PackageRoot 'Multica.exe') -Force
function Copy-Required([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { throw ('Missing required source: ' + $Source) }
  $parent = Split-Path -Parent $Destination
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}
function Copy-DirectoryFast([string]$Source, [string]$Destination, [string[]]$ExcludeDirectories = @(), [string[]]$ExcludeFiles = @()) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw ('Missing required source directory: ' + $Source) }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  $arguments = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($ExcludeDirectories.Count -gt 0) { $arguments += '/XD'; $arguments += $ExcludeDirectories }
  if ($ExcludeFiles.Count -gt 0) { $arguments += '/XF'; $arguments += $ExcludeFiles }
  & $robocopy @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw ('Directory copy failed: ' + $Source + ' (robocopy exit ' + $LASTEXITCODE + ')') }
}
Copy-DirectoryFast (Join-Path $RepoRoot 'mj-automation\scripts') (Join-Path $PackageRoot 'mj-automation\scripts') @('.browser-profile','__pycache__') @('.browser-profile.bridge.lock')
Copy-Required (Join-Path $RepoRoot 'mj-automation\start_mj_bridge.ps1') (Join-Path $PackageRoot 'mj-automation\start_mj_bridge.ps1')
Copy-Required (Join-Path $RepoRoot 'mj-automation\control') (Join-Path $PackageRoot 'mj-automation\control')
foreach ($relative in @('Install-Multica.cmd','Setup-Multica.cmd','Start-Multica.cmd','Stop-Multica.cmd','Open-Control.cmd','README_FIRST_RUN.md')) {
  Copy-Required (Join-Path $RepoRoot $relative) (Join-Path $PackageRoot $relative)
}
Copy-Required (Join-Path $RepoRoot 'config\local.ps1.example') (Join-Path $PackageRoot 'config\local.ps1.example')
$runtime = Join-Path $PackageRoot 'runtime'
$browserProfile = Join-Path $runtime 'browser-profile'
$nodeModules = Join-Path $runtime 'node_modules'
New-Item -ItemType Directory -Force -Path $browserProfile, $nodeModules | Out-Null
Set-Content -LiteralPath (Join-Path $browserProfile 'README.txt') -Value "此目录在分发包中为空；本机档案会在用户手动登录后创建。请勿分享此目录。" -Encoding UTF8
$sourceNodeModules = Join-Path $RepoRoot 'runtime\node_modules'
if (Test-Path -LiteralPath (Join-Path $sourceNodeModules 'playwright\package.json')) {
  Copy-DirectoryFast $sourceNodeModules $nodeModules
} else {
  throw ('Missing Playwright runtime package: ' + (Join-Path $sourceNodeModules 'playwright\package.json') + '. Restore runtime dependencies before building.')
}
$venvConfig = Join-Path $RepoRoot 'runtime\python\pyvenv.cfg'
$venvHome = $null
if (Test-Path -LiteralPath $venvConfig) {
  $homeLine = Get-Content -LiteralPath $venvConfig | Where-Object { $_ -match '^home\s*=' } | Select-Object -First 1
  if ($homeLine) { $venvHome = ($homeLine -replace '^home\s*=\s*', '').Trim() }
}
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
$bundledPythonHome = if ($env:MULTICA_PYTHON_HOME) { $env:MULTICA_PYTHON_HOME } elseif ($venvHome) { $venvHome } elseif ($pythonCommand) { Split-Path -Parent $pythonCommand.Source } else { $null }
if (-not $bundledPythonHome) { throw 'Python runtime source not found. Set MULTICA_PYTHON_HOME or provide runtime\python\pyvenv.cfg.' }
$bundledPythonExe = Join-Path $bundledPythonHome 'python.exe'
$bundledPythonTarget = Join-Path $runtime 'python'
if (-not (Test-Path -LiteralPath $bundledPythonExe)) { throw ('Python runtime executable missing: ' + $bundledPythonExe) }
if (Test-Path -LiteralPath $bundledPythonExe) {
  New-Item -ItemType Directory -Force -Path $bundledPythonTarget | Out-Null
  $bundledSitePackages = Join-Path $bundledPythonTarget 'Lib\site-packages'
  Copy-DirectoryFast $bundledPythonHome $bundledPythonTarget @((Join-Path $bundledPythonHome 'Lib\site-packages'))
  if (Test-Path -LiteralPath $bundledSitePackages) {
    $sitePackagesResolved = (Resolve-Path -LiteralPath $bundledSitePackages).Path
    $packageResolved = (Resolve-Path -LiteralPath $PackageRoot).Path
    if (-not $sitePackagesResolved.StartsWith($packageResolved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove Python packages outside this package.' }
    Remove-Item -LiteralPath $sitePackagesResolved -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $bundledSitePackages | Out-Null
  $sitePackagesSource = Join-Path $RepoRoot 'runtime\python\Lib\site-packages'
  $sitePackagesTarget = Join-Path $bundledPythonTarget 'Lib\site-packages'
  if (Test-Path -LiteralPath $sitePackagesSource) {
    New-Item -ItemType Directory -Force -Path $sitePackagesTarget | Out-Null
    Copy-DirectoryFast $sitePackagesSource $sitePackagesTarget
  }
}
$bundledNodeTarget = Join-Path $runtime 'node'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$bundledNodeSource = if ($env:MULTICA_NODE_EXE) { $env:MULTICA_NODE_EXE } elseif ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $bundledNodeSource -or -not (Test-Path -LiteralPath $bundledNodeSource)) { throw 'Node.js runtime source not found. Set MULTICA_NODE_EXE or add node.exe to PATH.' }
if (Test-Path -LiteralPath $bundledNodeSource) {
  New-Item -ItemType Directory -Force -Path $bundledNodeTarget | Out-Null
  Copy-Item -LiteralPath $bundledNodeSource -Destination (Join-Path $bundledNodeTarget 'node.exe') -Force
}
Set-Content -LiteralPath (Join-Path $runtime 'README.md') -Value "未随包提供的运行依赖会由 Setup-Multica.cmd 安装。" -Encoding UTF8
$generatedDirs = @('mj-automation\output','mj-automation\archive','mj-automation\receipts','mj-automation\run\jobs','mj-automation\run\logs','mj-automation\run\batches','mj-automation\run\batch-slots')
foreach ($relative in $generatedDirs) { New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot $relative) | Out-Null }
$manifest = [ordered]@{
  package = $PackageName
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  entrypoints = @('Multica.exe','Install-Multica.cmd','Setup-Multica.cmd','Start-Multica.cmd','Stop-Multica.cmd','Open-Control.cmd')
  desktopAppBundled = (Test-Path -LiteralPath (Join-Path $PackageRoot 'Multica.exe'))
  controlUrl = 'http://127.0.0.1:8765/control'
  includesBrowserProfile = $false
  includesCredentials = $false
  includesGeneratedMedia = $false
  sourceNodeModulesBundled = (Test-Path -LiteralPath (Join-Path $nodeModules 'playwright\package.json'))
  bundledPython = (Test-Path -LiteralPath (Join-Path $runtime 'python\python.exe'))
  bundledNode = (Test-Path -LiteralPath (Join-Path $runtime 'node\node.exe'))
  setupRequiredOnTargetMachine = -not ((Test-Path -LiteralPath (Join-Path $runtime 'python\python.exe')) -and (Test-Path -LiteralPath (Join-Path $runtime 'node\node.exe')) -and (Test-Path -LiteralPath (Join-Path $nodeModules 'playwright\package.json')))
  externalPrerequisites = @('Microsoft Edge', 'Microsoft Edge WebView2 Runtime')
}
if ($manifest.setupRequiredOnTargetMachine) { throw 'Runtime dependencies are missing; refusing to create an incomplete package.' }
$packagePython = Join-Path $runtime 'python\python.exe'
$dependencyProbe = "import sys; import fastapi, uvicorn, pydantic; from pathlib import Path; root=Path(sys.executable).resolve().parent; modules=[fastapi, uvicorn, pydantic]; assert all(root in Path(m.__file__).resolve().parents for m in modules), 'bridge dependencies resolve outside packaged Python runtime'"
& $packagePython '-I' '-c' $dependencyProbe
if ($LASTEXITCODE -ne 0) { throw 'The packaged Python runtime cannot import FastAPI, Uvicorn and Pydantic from its own files; refusing to create an incomplete package.' }
$manifest.pythonBridgeDependenciesReady = $true
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PackageRoot 'PACKAGE_MANIFEST.json') -Encoding UTF8
Compress-Archive -LiteralPath $PackageRoot -DestinationPath $ZipPath -CompressionLevel Optimal
$zip = Get-Item -LiteralPath $ZipPath
Write-Output ('BUILD OK: ' + $PackageRoot)
Write-Output ('ZIP: ' + $ZipPath + ' (' + [math]::Round($zip.Length / 1MB, 1) + ' MB)')
