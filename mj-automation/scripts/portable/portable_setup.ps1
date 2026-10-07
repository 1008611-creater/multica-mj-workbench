[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$RuntimeRoot = Join-Path $PackageRoot 'runtime'
$ConfigPath = Join-Path $PackageRoot 'config\local.ps1'
if (Test-Path -LiteralPath $ConfigPath) { . $ConfigPath }
$PythonCommand = if ($MulticaPython) { $MulticaPython } else { $null }
$NodeCommand = if ($MulticaNode) { $MulticaNode } else { $null }
function Find-CommandPath([string]$Preferred, [string[]]$Names) {
  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) { return (Resolve-Path -LiteralPath $Preferred).Path }
  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}
function Test-PythonReady([string]$Candidate) {
  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate)) { return $false }
  try {
    & $Candidate '-c' 'import fastapi, uvicorn, pydantic' 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}
$bundledPython = Join-Path $RuntimeRoot 'python\python.exe'
$bundledVenvPython = Join-Path $RuntimeRoot 'python\Scripts\python.exe'
$externalPython = Find-CommandPath $PythonCommand @('python.exe','python','py.exe','py')
$bundledPythonReady = Test-PythonReady $bundledPython
$bundledVenvReady = Test-PythonReady $bundledVenvPython
if ($bundledPythonReady) {
  $python = $bundledPython
  $pythonRuntime = $bundledPython
  $pythonIsBundled = $true
} elseif ($bundledVenvReady) {
  $python = $bundledVenvPython
  $pythonRuntime = $bundledVenvPython
  $pythonIsBundled = $true
} elseif ($externalPython) {
  $python = $externalPython
  $pythonRuntime = $null
  $pythonIsBundled = $false
} else {
  throw '需要 Python 3.10 或更新版本。安装后重新运行 Setup-Multica.cmd。'
}
$bundledNode = Join-Path $RuntimeRoot 'node\node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { Find-CommandPath $NodeCommand @('node.exe','node') }
$npm = Find-CommandPath $MulticaNpm @('npm.cmd','npm.exe','npm')
New-Item -ItemType Directory -Force -Path $RuntimeRoot, (Join-Path $RuntimeRoot 'browser-profile'), (Join-Path $RuntimeRoot 'node_modules') | Out-Null
$venv = Join-Path $RuntimeRoot 'python'
if (-not $pythonRuntime) {
  if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) {
    if ($python -match '(^|[\/])py(\.exe)?$') { & $python '-3' '-m' 'venv' $venv }
    else { & $python '-m' 'venv' $venv }
    if ($LASTEXITCODE -ne 0) { throw '无法创建本机 Python 运行环境。' }
  }
  $pythonRuntime = Join-Path $venv 'Scripts\python.exe'
}
$pythonReady = Test-PythonReady $pythonRuntime
if (-not $pythonReady) {
  if ($pythonIsBundled) { throw '内置 Python 运行环境缺少抽卡桥依赖，请重新安装最新版安装器。' }
  & $pythonRuntime '-m' 'pip' 'install' '--disable-pip-version-check' '--upgrade' 'pip'
  if ($LASTEXITCODE -ne 0) { throw '无法更新 Python 安装组件。' }
  $requirements = Join-Path $PackageRoot 'mj-automation\scripts\requirements.txt'
  & $pythonRuntime '-m' 'pip' 'install' '--disable-pip-version-check' '-r' $requirements
  if ($LASTEXITCODE -ne 0) { throw '无法安装抽卡桥所需组件。' }
}
$playwrightPackage = Join-Path $RuntimeRoot 'node_modules\playwright\package.json'
if (-not (Test-Path -LiteralPath $playwrightPackage)) {
  if (-not $node -or -not $npm) { throw '安装浏览器控制组件需要 Node.js 18 或更新版本。安装后重新运行 Setup-Multica.cmd。' }
  Push-Location $RuntimeRoot
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'package.json'))) {
      & $npm 'init' '-y' '--silent' | Out-Null
    }
    & $npm 'install' '--no-audit' '--no-fund' 'playwright@1.62.1'
    if ($LASTEXITCODE -ne 0) { throw '无法安装浏览器控制组件。' }
  } finally { Pop-Location }
}
$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:LOCALAPPDATA} 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$setup = [ordered]@{
  setupAt = (Get-Date).ToUniversalTime().ToString('o')
  python = $pythonRuntime
  pythonBundled = $pythonIsBundled
  node = if ($node) { $node } else { '缺' }
  nodeBundled = (Test-Path -LiteralPath $bundledNode)
  playwright = (Get-Content -LiteralPath $playwrightPackage -Raw | ConvertFrom-Json).version
  edgeDetected = ($edgeCandidates.Count -gt 0)
}
$setup | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'setup.json') -Encoding UTF8
Write-Output ('环境准备完成：' + $PackageRoot)
if ($edgeCandidates.Count -eq 0) { Write-Warning '未检测到 Microsoft Edge。只有安装 Edge 后才能打开登录浏览器。' }
