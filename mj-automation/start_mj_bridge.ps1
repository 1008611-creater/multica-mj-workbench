[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$Yes,
  [string]$LogFile = '',
  [switch]$NoDuplicate
)
$ErrorActionPreference = 'Stop'
$PortableStart = Join-Path $PSScriptRoot 'scripts\portable\portable_start.ps1'
if (-not (Test-Path -LiteralPath $PortableStart)) {
  throw ('找不到随安装包提供的桥接启动器：' + $PortableStart)
}
# 统一走随安装根目录定位运行时、浏览器档案和数据目录的正式启动入口。
# portable_start 自带健康检查和单实例保护；独立脚本不会打开浏览器或提交任务。
& $PortableStart -NoBrowser
if ($LASTEXITCODE -ne 0) {
  throw ('Multica 桥接启动失败，退出码：' + $LASTEXITCODE)
}
