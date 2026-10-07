[CmdletBinding()]
param([string]$TargetRoot,[switch]$SkipDesktopShortcut)
$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $TargetRoot) { $TargetRoot = Join-Path $env:LOCALAPPDATA 'Multica-Control-Console' }
$TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)
$excluded = @(
  'runtime\python',
  'runtime\browser-profile',
  'mj-automation\run',
  'mj-automation\output',
  'mj-automation\archive',
  'mj-automation\receipts',
  'config\local.ps1'
)
function Test-SkippedPath([string]$RelativePath) {
  foreach ($prefix in $excluded) {
    if ($RelativePath -eq $prefix -or $RelativePath.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
function Copy-TreeMerge([string]$SourceDirectory, [string]$DestinationDirectory, [string]$RelativeDirectory = '') {
  New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
  foreach ($child in Get-ChildItem -LiteralPath $SourceDirectory -Force) {
    $relativePath = if ($RelativeDirectory) { Join-Path $RelativeDirectory $child.Name } else { $child.Name }
    if (Test-SkippedPath $relativePath) { continue }
    $destinationPath = Join-Path $DestinationDirectory $child.Name
    if ($child.PSIsContainer) {
      Copy-TreeMerge -SourceDirectory $child.FullName -DestinationDirectory $destinationPath -RelativeDirectory $relativePath
    } else {
      Copy-Item -LiteralPath $child.FullName -Destination $destinationPath -Force
    }
  }
}
if ($TargetRoot.TrimEnd('\') -eq $SourceRoot.TrimEnd('\')) {
  $TargetRoot = $SourceRoot
} else {
  New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
  # 只清理旧版本升级脚本生成的可识别重复目录，不触碰用户数据目录。
  $legacyNestedCode = Join-Path $TargetRoot 'mj-automation\mj-automation\scripts\portable\portable_install.ps1'
  if (Test-Path -LiteralPath $legacyNestedCode) {
    Remove-Item -LiteralPath (Join-Path $TargetRoot 'mj-automation\mj-automation') -Recurse -Force
  }
  $legacyNestedRuntime = Join-Path $TargetRoot 'runtime\runtime\python\python.exe'
  if (Test-Path -LiteralPath $legacyNestedRuntime) {
    Remove-Item -LiteralPath (Join-Path $TargetRoot 'runtime\runtime') -Recurse -Force
  }
  Copy-TreeMerge -SourceDirectory $SourceRoot -DestinationDirectory $TargetRoot
  foreach ($runtimeRelative in @('runtime\python','runtime\node')) {
    $sourceRuntime = Join-Path $SourceRoot $runtimeRelative
    $targetRuntime = Join-Path $TargetRoot $runtimeRelative
    $runtimeExecutable = if ($runtimeRelative -eq 'runtime\python') { Join-Path $targetRuntime 'python.exe' } else { Join-Path $targetRuntime 'node.exe' }
    if ((Test-Path -LiteralPath $sourceRuntime) -and -not (Test-Path -LiteralPath $runtimeExecutable)) {
      New-Item -ItemType Directory -Force -Path $targetRuntime | Out-Null
      foreach ($child in Get-ChildItem -LiteralPath $sourceRuntime -Force) {
        if ($child.PSIsContainer) {
          Copy-Item -LiteralPath $child.FullName -Destination (Join-Path $targetRuntime $child.Name) -Recurse -Force
        } else {
          Copy-Item -LiteralPath $child.FullName -Destination (Join-Path $targetRuntime $child.Name) -Force
        }
      }
    }
  }
}
foreach ($dir in @('config','runtime\browser-profile','runtime\node_modules','mj-automation\run\jobs','mj-automation\run\logs','mj-automation\run\batches','mj-automation\run\batch-slots','mj-automation\output','mj-automation\archive','mj-automation\receipts')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $TargetRoot $dir) | Out-Null
}
$startPath = Join-Path $TargetRoot 'Start-Multica.cmd'
if (-not $SkipDesktopShortcut -and (Test-Path -LiteralPath $startPath)) {
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop) {
      $shortcutPath = Join-Path $desktop 'Multica Control.lnk'
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = $startPath
      $shortcut.WorkingDirectory = $TargetRoot
      $shortcut.WindowStyle = 1
      $shortcut.Description = 'Start the Multica local control console'
      $shortcut.Save()
    }
  } catch { Write-Warning ('未能创建桌面快捷方式：' + $_.Exception.Message) }
}
$setupPath = Join-Path $TargetRoot 'Setup-Multica.cmd'
if (-not (Test-Path -LiteralPath $setupPath)) { throw '安装目录中缺少 Setup-Multica.cmd。' }
$setup = Start-Process -FilePath $setupPath -WorkingDirectory $TargetRoot -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw ('运行环境准备失败，错误代码：' + $setup.ExitCode) }
Write-Output ('安装完成：' + $TargetRoot)
