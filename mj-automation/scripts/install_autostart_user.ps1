# =====================================================================
# MJ 生图桥接服务 · 开机自启与看护（免管理员版）
# =====================================================================
#
# 和 scripts\install_autostart.ps1 的区别：
#   那一版用「计划任务」，部分机器上要管理员权限（会弹 UAC）。
#   这一版用「登录启动项 + 常驻看护循环」，完全在普通用户权限内，
#   双击一次装好，之后开机自动拉起，掉线 5 分钟内自动恢复。
#
# 装了什么：
#   启动项  %APPDATA%\...\Startup\MJ-Bridge-Autostart.vbs
#     -> 开机登录时以隐藏窗口拉起 scripts\watchdog_loop.ps1
#   看护循环 watchdog_loop.ps1
#     -> 每 5 分钟调一次 watchdog_mj_bridge.ps1，桥掉线就拉起来
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install_autostart_user.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install_autostart_user.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File .\scripts\install_autostart_user.ps1 -Uninstall
#
# 红线：只注册「拉起本地服务」的启动项，不代登录、不出图、不发布、不扣积分。

param(
    [switch]$Uninstall,
    [switch]$Status,
    [int]$IntervalSec = 300
)

$ErrorActionPreference = 'Stop'

$Root     = 'E:\codex\multica\mj-automation'
$Loop     = Join-Path $Root 'scripts\watchdog_loop.ps1'
$LogDir   = Join-Path $Root 'run\logs'
$LoopLog  = Join-Path $LogDir 'watchdog-loop.log'
$Startup  = [Environment]::GetFolderPath('Startup')
$VbsPath  = Join-Path $Startup 'MJ-Bridge-Autostart.vbs'

function Say($t) { Write-Host ('==> ' + $t) -ForegroundColor Cyan }
function Ok($t)  { Write-Host ('    OK  ' + $t) -ForegroundColor Green }
function Bad($t) { Write-Host ('    !!  ' + $t) -ForegroundColor Yellow }

function Test-LoopRunning {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine.Contains('watchdog_loop.ps1')) { return $true }
        }
    } catch { }
    return $false
}

Write-Host ''
Write-Host 'MJ 桥 · 开机自启与看护（免管理员）' -ForegroundColor White
Write-Host ('=' * 62)

if ($Status) {
    Say '当前注册状态'
    if (Test-Path $VbsPath) { Ok ('启动项已注册: ' + $VbsPath) } else { Bad ('启动项未注册: ' + $VbsPath) }
    if (Test-LoopRunning) { Ok '看护循环正在运行' } else { Bad '看护循环没在运行' }
    try {
        $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 6
        Ok ('桥在跑，版本 ' + $h.bridge)
    } catch { Bad '桥没在跑（看护循环会在 5 分钟内把它拉起来）' }
    if (Test-Path $LoopLog) {
        Write-Host ''; Write-Host '最近看护循环日志：' -ForegroundColor White
        Get-Content $LoopLog -Tail 8 | ForEach-Object { Write-Host ('    ' + $_) }
    }
    exit 0
}

if ($Uninstall) {
    Say '卸载启动项'
    if (Test-Path $VbsPath) { Remove-Item -Force $VbsPath; Ok ('已删除 ' + $VbsPath) } else { Ok '启动项本来就没有' }
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine.Contains('watchdog_loop.ps1')) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                Ok ('已停止看护循环 pid=' + $p.ProcessId)
            }
        }
    } catch { }
    Write-Host ''; Write-Host '    注意：桥服务本身没被停掉，需要的话手动关掉那个窗口。' -ForegroundColor Yellow
    exit 0
}

# --- 安装 -------------------------------------------------------------
if (-not (Test-Path $Loop)) { Bad ('找不到 ' + $Loop); exit 1 }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

Say '写入登录启动项（不需要管理员权限）'
# VBS 以隐藏窗口拉起看护循环：powershell -WindowStyle Hidden 仍会闪一下黑框，
# 用 WScript.Shell.Run 的第二个参数 0 才能真正做到无窗口。
# VBS 以隐藏窗口拉起看护循环：powershell -WindowStyle Hidden 仍会闪一下黑框，
# 用 WScript.Shell.Run 的第二个参数 0 才能真正做到无窗口。
# 用单引号 here-string（不插值），避免 VBS 里的双引号与 PowerShell 打架。
$vbsTemplate = @'
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""__LOOP__"" -IntervalSec __INTERVAL__", 0, False
'@
$vbsText = $vbsTemplate.Replace('__LOOP__', $Loop).Replace('__INTERVAL__', [string]$IntervalSec)
# VBS 按 ANSI 读，中文注释会乱码；这里刻意只用纯 ASCII，避免编码问题。
Set-Content -Path $VbsPath -Value $vbsText -Encoding ASCII -Force
Ok ('启动项已写入: ' + $VbsPath)

Say '立刻拉起看护循环（不用等下次开机）'
if (Test-LoopRunning) {
    Ok '看护循环已经在跑了，不重复启动'
} else {
    try {
        & wscript.exe $VbsPath
        Start-Sleep -Seconds 3
        if (Test-LoopRunning) { Ok '看护循环已启动（后台隐藏运行）' } else { Bad '看护循环似乎没起来，请跑一次 2_查看运行状态.cmd 看看' }
    } catch { Bad ('启动失败: ' + $_.Exception.Message) }
}

Say '等桥起来（看护循环会自动把它拉起来）'
$up = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 5
        if ($h -and $h.ok) { $up = $true; Ok ('桥已就绪，版本 ' + $h.bridge); break }
    } catch { }
    Start-Sleep -Seconds 3
}
if (-not $up) { Bad '桥还没起来。多半是代理没开（127.0.0.1:7897），先打开代理再看一次。' }

Write-Host ''
Write-Host ('=' * 62)
Ok '安装完成。从现在起：开机自动拉起，掉线 5 分钟内自动恢复。'
Write-Host ('    看护循环日志: ' + $LoopLog)
Write-Host ('    服务日志:     ' + (Join-Path $LogDir ('bridge-' + (Get-Date -Format 'yyyyMMdd') + '.log')))
Write-Host ''
Write-Host '    注意：代理（127.0.0.1:7897）仍需你自己开着 —— 它是联网前置，脚本无法替你开。' -ForegroundColor Yellow
Write-Host ''
