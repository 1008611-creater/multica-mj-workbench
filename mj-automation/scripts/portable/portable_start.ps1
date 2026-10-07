[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$ConfigPath = Join-Path $PackageRoot 'config\local.ps1'
if (Test-Path -LiteralPath $ConfigPath) { . $ConfigPath }
$port = if ($MulticaPort) { [int]$MulticaPort } else { 8765 }
$root = Join-Path $PackageRoot 'mj-automation'
$scripts = Join-Path $root 'scripts'
$run = Join-Path $root 'run'
$logs = Join-Path $run 'logs'
$jobs = Join-Path $run 'jobs'
$output = Join-Path $root 'output'
$archive = Join-Path $root 'archive'
$receipts = Join-Path $root 'receipts'
$runtime = Join-Path $PackageRoot 'runtime'
$profile = Join-Path $runtime 'browser-profile'
$nodeModules = Join-Path $runtime 'node_modules'
function Test-PythonReady([string]$Candidate) {
  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate)) { return $false }
  try { & $Candidate '-c' 'import fastapi, uvicorn, pydantic' 2>$null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
$bundledPython = Join-Path $runtime 'python\python.exe'
$venvPython = Join-Path $runtime 'python\Scripts\python.exe'
$pythonSelected = if (Test-PythonReady $bundledPython) { $bundledPython } elseif (Test-PythonReady $venvPython) { $venvPython } elseif (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { $venvPython }
$pidPath = Join-Path $run 'portable-server.pid'
$healthUrl = 'http://127.0.0.1:' + $port + '/health'
foreach ($dir in @($run,$logs,$jobs,$output,$archive,$receipts,$profile,$nodeModules)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$pauseFile = Join-Path $run 'bridge-control-paused'
if (-not (Test-Path -LiteralPath $pauseFile)) { New-Item -ItemType File -Path $pauseFile | Out-Null }
$venvPython = $pythonSelected
if (-not (Test-Path -LiteralPath $venvPython) -or -not (Test-PythonReady $venvPython)) {
  & (Join-Path $PackageRoot 'Setup-Multica.cmd')
  if ($LASTEXITCODE -ne 0) { throw '请先运行 Setup-Multica.cmd 准备运行环境。' }
  if (Test-PythonReady $bundledPython) { $venvPython = $bundledPython } elseif (Test-PythonReady (Join-Path $runtime 'python\\Scripts\\python.exe')) { $venvPython = Join-Path $runtime 'python\\Scripts\\python.exe' } else { throw '内置 Python 运行环境缺少抽卡桥依赖，请重新安装最新版安装器。' }
}
$env:MJ_BRIDGE_PORT = [string]$port
$env:MJ_OUTPUT_DIR = $output
$env:MJ_JOBS_DIR = $jobs
$env:MJ_RECEIPTS_DIR = $receipts
$env:MJ_ARCHIVE_DIR = $archive
$env:MXAI_PROFILE = $profile
$env:MXAI_NODE_MODULES = $nodeModules
$env:MXAI_ADAPTER_PATH = Join-Path $scripts 'mxai_adapter.js'
$env:MJ_BRIDGE_TIMEOUT_MS = if ($MulticaTimeoutMs) { [string]$MulticaTimeoutMs } else { '1200000' }
if ($MulticaProxy) { $env:MXAI_PROXY = [string]$MulticaProxy }
if ($MulticaMxaiUrl) { $env:MXAI_URL = [string]$MulticaMxaiUrl }
$existing = $null
if (Test-Path -LiteralPath $pidPath) {
  $existingRaw = (Get-Content -LiteralPath $pidPath -Raw).Trim()
  $existingPid = 0
  if ([int]::TryParse($existingRaw, [ref]$existingPid)) { $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue }
}
try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
  if ($health.ok) {
    if (-not $NoBrowser) { Start-Process $healthUrl }
    Write-Output ('控制台已在运行：' + $healthUrl)
    exit 0
  }
} catch {}
if ($existing) { Stop-Process -Id $existing.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
$serverLog = Join-Path $logs 'portable-server.log'
$serverErr = Join-Path $logs 'portable-server-error.log'
$proc = Start-Process -FilePath $venvPython -ArgumentList @('server.py') -WorkingDirectory $scripts -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr -PassThru
$proc.Id | Set-Content -LiteralPath $pidPath -Encoding ASCII
$deadline = (Get-Date).AddSeconds(35)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.ok) { $healthy = $true; break }
  } catch {}
}
if (-not $healthy) {
  & (Join-Path $PackageRoot 'Stop-Multica.cmd') | Out-Null
  $tail = if (Test-Path -LiteralPath $serverErr) { (Get-Content -LiteralPath $serverErr -Tail 12) -join ' ' } else { '' }
  throw ('本机控制台未能正常启动：' + $tail)
}
if (-not $NoBrowser) { Start-Process ('http://127.0.0.1:' + $port + '/control') }
Write-Output ('控制台已启动：http://127.0.0.1:' + $port + '/control')





