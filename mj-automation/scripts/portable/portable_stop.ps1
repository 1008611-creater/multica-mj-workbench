[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$pidPath = Join-Path $PackageRoot 'mj-automation\run\portable-server.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output '控制台已停止，未发现运行记录。'; exit 0 }
$raw = (Get-Content -LiteralPath $pidPath -Raw).Trim()
$targetPid = 0
if (-not [int]::TryParse($raw, [ref]$targetPid)) { Remove-Item -LiteralPath $pidPath -Force; Write-Output '已清理无效的旧运行记录。'; exit 0 }
$proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($proc) {
  $cim = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $targetPid) -ErrorAction SilentlyContinue
  $cmdline = if ($cim) { [string]$cim.CommandLine } else { '' }
  $runtimePythonCandidates = @((Join-Path $PackageRoot 'runtime\python\Scripts\python.exe'), (Join-Path $PackageRoot 'runtime\python\python.exe'))
  $resolvedProcPath = if ($proc.Path) { (Resolve-Path -LiteralPath $proc.Path).Path } else { '' }
  $isBundledPython = $false
  foreach ($candidate in $runtimePythonCandidates) {
    if ((Test-Path -LiteralPath $candidate) -and $resolvedProcPath -and ($resolvedProcPath -eq (Resolve-Path -LiteralPath $candidate).Path)) { $isBundledPython = $true; break }
  }
  $isPortable = ($cmdline -match [regex]::Escape((Join-Path $PackageRoot 'mj-automation\scripts'))) -or $isBundledPython
  if (-not $isPortable) { throw ('为避免关闭其他程序，未停止进程：' + $targetPid + ': it is not the Multica portable server.') }
  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
}
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Output '控制台已停止。'
