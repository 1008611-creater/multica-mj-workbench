# =====================================================================
# MJ 生图桥接服务 · 看护循环（免管理员版）
# =====================================================================
#
# 它做的事：
#   每 N 秒调一次 watchdog_mj_bridge.ps1（那个脚本只做一件事：桥掉线就拉起来）。
#   由「登录启动项」在开机时以隐藏窗口拉起，之后一直待在后台。
#
# 为什么不用计划任务：注册计划任务在部分机器上要管理员权限（会弹 UAC）。
#   登录启动项 + 常驻循环完全在用户权限内，装一次永久有效。
#
# 用法（一般由启动项自动调用，不用手敲）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\watchdog_loop.ps1
#
# 红线：本脚本只负责「把服务拉起来」，不出图、不登录、不发布、不扣积分。

param(
    [int]$IntervalSec = 300,
    [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'

$Root     = 'E:\codex\multica\mj-automation'
$Watchdog = Join-Path $Root 'scripts\watchdog_mj_bridge.ps1'
$LogDir   = Join-Path $Root 'run\logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
if (-not $LogFile) { $LogFile = Join-Path $LogDir 'watchdog-loop.log' }

function Write-LoopLog($text) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $text
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

# 日志超过 1MB 就滚动一次，避免无限增长
try {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1048576)) {
        Move-Item -Force $LogFile ($LogFile + '.1')
    }
} catch { }

Write-LoopLog ('loop started, interval=' + $IntervalSec + 's, pid=' + $PID)

while ($true) {
    try {
        if (Test-Path $Watchdog) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Watchdog 2>&1 | Out-Null
        } else {
            Write-LoopLog ('ERROR watchdog not found: ' + $Watchdog)
        }
    } catch {
        Write-LoopLog ('ERROR watchdog call failed: ' + $_.Exception.Message)
    }
    Start-Sleep -Seconds $IntervalSec
}
