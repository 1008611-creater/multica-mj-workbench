# =====================================================================
# MJ 生图桥接服务 · 一键安装开机自启 + 看护（Windows 计划任务）
# =====================================================================
#
# 它做的事（装一次，之后长期有效）：
#   任务一 MJ-Bridge-Autostart : 开机（登录后）自动把桥拉起来，隐藏窗口
#   任务二 MJ-Bridge-Watchdog  : 每 5 分钟体检一次，掉线自动拉起 / 卡死安全重启
#
# 为什么需要：桥是「稳定出图」的唯一入口。手动开的窗口一关、机器一重启，
# 链路就断了，而且断得很安静 —— 任务会一直卡在排队，等到发现已经白等十几分钟。
#
# 用法（本机 PowerShell 里跑一次即可）：
#   powershell -ExecutionPolicy Bypass -File E:\codex\multica\mj-automation\scripts\install_autostart.ps1
#
# 卸载：
#   powershell -ExecutionPolicy Bypass -File E:\codex\multica\mj-automation\scripts\install_autostart.ps1 -Uninstall
#
# 状态：
#   powershell -ExecutionPolicy Bypass -File E:\codex\multica\mj-automation\scripts\install_autostart.ps1 -Status
#
# 红线：只注册「拉起本地服务」的计划任务，不代登录、不出图、不发布、不扣积分。

param(
    [switch]$Uninstall,
    [switch]$Status,
    [int]$WatchdogIntervalMinutes = 5
)

$ErrorActionPreference = 'Stop'

$Root     = 'E:\codex\multica\mj-automation'
$Starter  = Join-Path $Root 'start_mj_bridge.ps1'
$Watchdog = Join-Path $Root 'scripts\watchdog_mj_bridge.ps1'
$LogDir   = Join-Path $Root 'run\logs'
$TaskA    = 'MJ-Bridge-Autostart'
$TaskW    = 'MJ-Bridge-Watchdog'

function Say($t)  { Write-Host ('==> ' + $t) -ForegroundColor Cyan }
function Ok($t)   { Write-Host ('    OK  ' + $t) -ForegroundColor Green }
function Bad($t)  { Write-Host ('    !!  ' + $t) -ForegroundColor Yellow }

Write-Host ''
Write-Host 'MJ 桥 · 开机自启与看护' -ForegroundColor White
Write-Host ('=' * 62)

if (-not (Test-Path $Starter))  { Bad ('找不到 ' + $Starter); exit 1 }
if (-not (Test-Path $Watchdog)) { Bad ('找不到 ' + $Watchdog); exit 1 }
if (-not (Test-Path $LogDir))   { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

if ($Status) {
    Say '当前注册状态'
    foreach ($name in @($TaskA, $TaskW)) {
        $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($t) {
            $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
            Ok ($name + '  state=' + $t.State + '  lastRun=' + $info.LastRunTime + '  lastResult=' + $info.LastTaskResult)
        } else {
            Bad ($name + '  未注册')
        }
    }
    $wl = Join-Path $LogDir 'watchdog.log'
    if (Test-Path $wl) { Write-Host ''; Write-Host '最近看护日志：' -ForegroundColor White; Get-Content $wl -Tail 12 | ForEach-Object { Write-Host ('    ' + $_) } }
    exit 0
}

if ($Uninstall) {
    Say '卸载计划任务'
    foreach ($name in @($TaskA, $TaskW)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Ok ('已删除 ' + $name)
        } else { Ok ($name + ' 本来就没有') }
    }
    exit 0
}

# --- 注册 -------------------------------------------------------------
Say '注册计划任务（需要管理员权限；若报拒绝，请用管理员身份重开 PowerShell 再跑一次）'

$actionA = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $Starter + '" -Yes -NoDuplicate -LogFile "' + (Join-Path $LogDir 'bridge.log') + '"')
$triggerA = New-ScheduledTaskTrigger -AtLogOn
$setA = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principalA = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskA -Action $actionA -Trigger $triggerA -Settings $setA -Principal $principalA -Description 'MJ 生图桥：登录后自动启动（隐藏窗口，日志落 run\logs\bridge.log）' -Force | Out-Null
Ok ($TaskA + ' 已注册（登录后自动启动）')

$actionW = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $Watchdog + '"')
$triggerW = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes)
$setW = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principalW = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskW -Action $actionW -Trigger $triggerW -Settings $setW -Principal $principalW -Description ('MJ 生图桥：每 ' + $WatchdogIntervalMinutes + ' 分钟体检一次，掉线自动拉起') -Force | Out-Null
Ok ($TaskW + ' 已注册（每 ' + $WatchdogIntervalMinutes + ' 分钟一次）')

Write-Host ''
Write-Host ('=' * 62)
Ok '安装完成。从现在起：开机自动拉起，掉线 5 分钟内自动恢复。'
Write-Host ('    看护日志: ' + (Join-Path $LogDir 'watchdog.log'))
Write-Host ('    服务日志: ' + (Join-Path $LogDir 'bridge.log'))
Write-Host ('    查看状态: powershell -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Status')
Write-Host ''
Write-Host '    注意：代理（127.0.0.1:7897）仍需你自己开着 —— 它是联网前置，脚本无法替你开。' -ForegroundColor Yellow
Write-Host ''
