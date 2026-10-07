# =====================================================================
# MJ 生图桥接服务 · 看护脚本（掉线自动拉起）
# =====================================================================
#
# 它做的事（由计划任务每 5 分钟调用一次）：
#   1. 问一次 /health，正常就安静退出
#   2. 端口没人听        -> 后台把桥重新拉起来（隐藏窗口，输出落盘）
#   3. 端口有人听但不通  -> 走桥自带的两步式安全重启（金丝雀先验证再切）
#   4. 两次动作之间有最小间隔，避免反复重启把机器拖垮
#
# 用法（装好自启后由计划任务调用，一般不用手敲）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\watchdog_mj_bridge.ps1
#
# 红线：本脚本只负责「把服务拉起来」，不出图、不登录、不发布、不扣积分。

param(
    [int]$Port = 8765,
    [int]$MinIntervalSec = 120,
    [int]$RecoverAfterMinutes = 8,
    [int]$RecoverMaxAttempts = 2,
    [int]$RecoverMinGapMinutes = 30,
    [int]$RecoverMaxAgeHours = 24,
    [int]$RecoverTimeoutSec = 650,
    [switch]$RecoverOnly,
    [switch]$NoRecover,
    [switch]$DryRun,
    [switch]$Chatty
)

$ErrorActionPreference = 'Continue'

# 【2026-09-14】-DryRun：只把「这一轮会挑中谁」打印出来，不拉浏览器、不调补下载。
# 为什么需要：补下载一旦真的发起，就会开一次可见浏览器、白等十几分钟。
# 想验证筛选规则改对没有，不该付出这个代价 —— 先用 DryRun 看命中名单。
$script:DryRunMode = [bool]$DryRun

$Root      = 'E:\codex\multica\mj-automation'
$Starter   = Join-Path $Root 'start_mj_bridge.ps1'
$LogDir    = Join-Path $Root 'run\logs'
$LogFile   = Join-Path $LogDir 'watchdog.log'
$StateFile = Join-Path $LogDir 'watchdog-state.json'
$JobDir       = Join-Path $Root 'run\jobs'
$BrowserLock  = Join-Path $Root 'run\mj-browser.lock'
$RecoverLog   = Join-Path $LogDir 'redownload.log'
$RecoverState = Join-Path $LogDir 'redownload-state.json'
$RecoverLock  = Join-Path $LogDir 'redownload.lock'
$ControlPause = Join-Path $Root 'run\bridge-control-paused'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
if (Test-Path $ControlPause) {
    Write-Log 'PAUSED' 'local control console pause is active; no bridge start/restart/recovery action'
    exit 0
}

# 日志超过 2MB 就滚动一次，避免无限增长
try {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 2097152)) {
        Move-Item -Force $LogFile ($LogFile + '.1')
    }
} catch { }

function Write-Log($level, $text) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] [' + $level + '] ' + $text
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
    if ($Chatty) { Write-Host $line }
}

function Read-State {
    try { if (Test-Path $StateFile) { return (Get-Content -Raw -Path $StateFile | ConvertFrom-Json) } } catch { }
    return $null
}

# 只更新状态，不动 lastActionAt（保证最小间隔按「真正动过手」计算）
function Write-Status($status, $note) {
    $prev = Read-State
    $last = $null
    if ($prev -and $prev.lastActionAt) { $last = $prev.lastActionAt }
    $obj = @{
        updatedAt    = (Get-Date).ToString('o')
        lastStatus   = $status
        lastActionAt = $last
        note         = $note
        port         = $Port
    }
    try { $obj | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8 } catch { }
}

# 真正动手（拉起/重启）时调用，刷新 lastActionAt
function Write-Action($status, $note) {
    $obj = @{
        updatedAt    = (Get-Date).ToString('o')
        lastStatus   = $status
        lastActionAt = (Get-Date).ToString('o')
        note         = $note
        port         = $Port
    }
    try { $obj | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8 } catch { }
}

# 端口有没有人在听（用 .NET，比 Test-NetConnection 快很多）
function Test-PortListening($p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(1200, $false)) { $client.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { try { $client.Close() } catch { } }
}

function Get-Health($p) {
    try { return (Invoke-RestMethod -Uri ('http://127.0.0.1:' + $p + '/health') -TimeoutSec 8) } catch { return $null }
}

# 距上次真正动手是否已超过最小间隔
function Test-CanAct {
    $st = Read-State
    if (-not $st -or -not $st.lastActionAt) { return $true }
    try {
        $last = [datetime]::Parse($st.lastActionAt)
        return (((Get-Date) - $last).TotalSeconds -ge $MinIntervalSec)
    } catch { return $true }
}

# --- 排队超时自动补下载：辅助函数（只补下载，绝不重跑出图）----------

# 补下载是否已经在跑：
#   1. 浏览器锁若在最近 120 秒内被心跳刷新过，说明有别的活正用着同一个浏览器，
#      这时候抢着再开一个只会互相打断 —— 直接让路。
#   2. 补下载锁里的进程还活着、且没超过超时上限，才算真在跑。
#   3. 进程已死或已超时：把陈旧锁清掉，免得补下载被永久卡住。
function Test-RecoverRunning {
    try {
        if (Test-Path $BrowserLock) {
            $age = ((Get-Date) - (Get-Item $BrowserLock).LastWriteTime).TotalSeconds
            if ($age -lt 120) { return $true }
        }
    } catch { }
    if (-not (Test-Path $RecoverLock)) { return $false }
    try {
        $lk = Get-Content -Raw -Path $RecoverLock | ConvertFrom-Json
        $lockPid = [int]$lk.pid
        $alive = $false
        try { $alive = [bool](Get-Process -Id $lockPid -ErrorAction Stop) } catch { $alive = $false }
        $fresh = $true
        if ($lk.startedAt) { $fresh = (((Get-Date) - [datetime]::Parse($lk.startedAt)).TotalSeconds -lt $RecoverTimeoutSec) }
        if ($alive -and $fresh) { return $true }
        Remove-Item -Force $RecoverLock -ErrorAction SilentlyContinue
    } catch {
        Remove-Item -Force $RecoverLock -ErrorAction SilentlyContinue
    }
    return $false
}

# 补下载台账：每个 serial 试过几次、上次什么时候试的、结果如何。
# 台账坏了就当空的，绝不因为台账读不出来就停摆。
function Read-RecoverState {
    $map = @{}
    try {
        if (Test-Path $RecoverState) {
            $obj = Get-Content -Raw -Path $RecoverState | ConvertFrom-Json
            if ($obj) { foreach ($p in $obj.PSObject.Properties) { $map[$p.Name] = $p.Value } }
        }
    } catch { }
    return $map
}

function Write-RecoverState($map) {
    try { $map | ConvertTo-Json -Depth 6 | Set-Content -Path $RecoverState -Encoding UTF8 } catch { }
}

# 挑一条「值得补下载」的作业：
#   1. 只认结果 JSON 里的 status（queued / download_failed）。
#      作业层 status 一律是 done，拿它判断会永远以为没事。
#   2. 必须有 serial-<数字> 形式的 recordId，补下载全靠它。
#   3. 同一个 serial 试过太多次、或距上次尝试太近，就跳过。
#   4. 出图目录/归档目录里已经有这张图：记为已解决并跳过（省一整轮浏览器往返）。
#   5. 【2026-09-14】receipt_pending / page_reported_failed 都不再算候选：
#      前者是「点了生成但没拿到确定回执」，后者是「平台已判定本次生成失败」。
#      两者在站点侧都不会再出图，本地也不会有成品 —— 补下载跑一百遍也是空手而归，
#      只会白开一次可见浏览器、白等十几分钟。排队（queued）才是真正值得补下载的状态。
function Select-DueCandidate {
    $dirs = @()
    if ($env:MJ_ARCHIVE_DIR) { $dirs += $env:MJ_ARCHIVE_DIR }
    $dirs += (Join-Path $Root 'output')
    $state = Read-RecoverState
    $files = @()
    try {
        $files = Get-ChildItem -Path $JobDir -Filter '*.json' -File -ErrorAction Stop |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 20
    } catch { return $null }
    foreach ($f in $files) {
        $job = $null
        try { $job = Get-Content -Raw -Path $f.FullName | ConvertFrom-Json } catch { continue }
        if (-not $job) { continue }
        $status = [string]$job.status
        if ($status -notin @('queued', 'download_failed')) { continue }
        $serial = [string]$job.recordId
        if (-not $serial) { continue }
        if ($serial -notmatch '^serial-\d+$') { continue }
        # 太老的作业不再自动补：多半已经被新版本取代，追它只会白开一次浏览器。
        if (((Get-Date) - $f.LastWriteTime).TotalHours -gt $RecoverMaxAgeHours) { continue }
        $num = $serial.Substring('serial-'.Length)
        $found = $null
        foreach ($d in $dirs) {
            if (-not $d) { continue }
            try {
                $hit = Get-ChildItem -Path $d -File -ErrorAction SilentlyContinue |
                       Where-Object { $_.Name.Contains($num) -and $_.Extension -match '^\.(png|jpg|jpeg|webp)$' } |
                       Select-Object -First 1
                if ($hit) { $found = $hit.FullName; break }
            } catch { }
        }
        $rec = $state[$serial]
        if ($found) {
            if (-not $rec) {
                if ($script:DryRunMode) {
                    Write-Log 'DRYRUN' ('local hit (would mark resolved): ' + $serial)
                } else {
                    $state[$serial] = @{ attempts = 0; lastStatus = 'resolved_local'; lastAttemptAt = (Get-Date).ToString('o'); file = $found }
                    Write-RecoverState $state
                    Write-Log 'RECOVER' ('local hit, marked resolved: ' + $serial)
                }
            }
            continue
        }
        $attempts = 0
        $lastAt = $null
        if ($rec) {
            if ($rec.attempts) { $attempts = [int]$rec.attempts }
            if ($rec.lastAttemptAt) { $lastAt = [datetime]::Parse($rec.lastAttemptAt) }
        }
        if ($attempts -ge $RecoverMaxAttempts) { continue }
        if ($lastAt) {
            if (((Get-Date) - $lastAt).TotalMinutes -lt $RecoverMinGapMinutes) { continue }
        }
        return [pscustomobject]@{
            Serial = $serial
            Num    = $num
            Prefix = $f.BaseName
            Status = $status
            Job    = $f.FullName
        }
    }
    return $null
}

# 真正去补一次下载：只调 dl-serial（免费取回已出好的图），
# 绝不碰出图接口 —— 不重跑、不重复扣积分。
function Invoke-RecoverQueued {
    if (Test-RecoverRunning) { return }
    $cand = Select-DueCandidate
    if (-not $cand) { return }
    if ($script:DryRunMode) {
        Write-Log 'DRYRUN' ('would redownload ' + $cand.Serial + ' (status=' + $cand.Status + ', job=' + $cand.Prefix + ') - nothing launched')
        return
    }
    $lockObj = @{ pid = $PID; startedAt = (Get-Date).ToString('o'); serial = $cand.Serial }
    try { $lockObj | ConvertTo-Json | Set-Content -Path $RecoverLock -Encoding UTF8 } catch { }
    $t0 = Get-Date
    try {
        Write-Log 'RECOVER' ('try redownload ' + $cand.Serial + ' (status=' + $cand.Status + ')')
        $body = @{ mode = 'dl-serial'; serial = $cand.Serial; prefix = $cand.Prefix } | ConvertTo-Json
        $resp = Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $Port + '/v1/maintenance') -Body $body -ContentType 'application/json' -TimeoutSec $RecoverTimeoutSec
        $secs = [int]((Get-Date) - $t0).TotalSeconds
        $state = Read-RecoverState
        $prev = $state[$cand.Serial]
        $attempts = 1
        if ($prev -and $prev.attempts) { $attempts = [int]$prev.attempts + 1 }
        $state[$cand.Serial] = @{
            attempts      = $attempts
            lastAttemptAt = (Get-Date).ToString('o')
            lastStatus    = [string]$resp.status
            lastOk        = [bool]$resp.ok
            file          = [string]$resp.file
            elapsedSec    = $secs
        }
        Write-RecoverState $state
        try {
            Add-Content -Path $RecoverLog -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $cand.Serial + ' ok=' + $resp.ok + ' status=' + $resp.status + ' cached=' + $resp.cached + ' ' + $secs + 's file=' + $resp.file) -Encoding UTF8
        } catch { }
        Write-Log 'RECOVER' ('done ' + $cand.Serial + ' ok=' + $resp.ok + ' status=' + $resp.status + ' cached=' + $resp.cached + ' ' + $secs + 's')
    } catch {
        $secs = [int]((Get-Date) - $t0).TotalSeconds
        $state = Read-RecoverState
        $prev = $state[$cand.Serial]
        $attempts = 1
        if ($prev -and $prev.attempts) { $attempts = [int]$prev.attempts + 1 }
        $state[$cand.Serial] = @{
            attempts      = $attempts
            lastAttemptAt = (Get-Date).ToString('o')
            lastStatus    = 'error'
            lastOk        = $false
            error         = $_.Exception.Message
            elapsedSec    = $secs
        }
        Write-RecoverState $state
        Write-Log 'WARN' ('redownload failed ' + $cand.Serial + ': ' + $_.Exception.Message)
    } finally {
        Remove-Item -Force $RecoverLock -ErrorAction SilentlyContinue
    }
}

# --- 排队超时自动补下载（只补下载，绝不重跑出图）--------------------
if ($RecoverOnly) {
    Invoke-RecoverQueued
    exit 0
}

if (-not (Test-Path $Starter)) { Write-Log 'ERROR' ('starter not found: ' + $Starter); exit 1 }

# --- 1. 正常就安静退出 -------------------------------------------------
$health = Get-Health $Port
if ($health -and $health.ok) {
    $st = Read-State
    if ($st -and $st.lastStatus -eq 'down') { Write-Log 'RECOVERED' ('bridge is back, build=' + $health.bridge) }
    elseif ($Chatty) { Write-Log 'OK' ('build=' + $health.bridge) }
    Write-Status 'up' ''
    if (-not $NoRecover) {
        try {
            if ($script:DryRunMode) {
                Invoke-RecoverQueued     # DryRun 下它只记一行 DRYRUN 日志，不会真的发起补下载
            }
            elseif (-not (Test-RecoverRunning) -and (Select-DueCandidate)) {
                # [FIX-20260914-SELFHEAL] 子进程输出落盘，方便排查。
                $spawnLog = Join-Path $LogDir ('recover-spawn-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
                Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-RecoverOnly') -WindowStyle Hidden -RedirectStandardOutput $spawnLog -RedirectStandardError ($spawnLog + '.err')
            }
        } catch { Write-Log 'WARN' ('recover spawn failed: ' + $_.Exception.Message) }
    }
    exit 0
}

$listening = Test-PortListening $Port
$who = 'port-not-listening'
if ($listening) { $who = 'port-held-but-unhealthy' }

if (-not (Test-CanAct)) {
    Write-Log 'SKIP' ($who + ' ; last action too recent (min ' + $MinIntervalSec + 's)')
    exit 0
}

# --- 2. 端口没人听：直接拉起来 -----------------------------------------
if (-not $listening) {
    $bridgeLog = Join-Path $LogDir ('bridge-' + (Get-Date -Format 'yyyyMMdd') + '.log')
    Write-Log 'START' ('bridge not listening -> launching starter; log=' + $bridgeLog)
    Write-Action 'down' 'launch-starter'
    try {
        # [FIX-20260914-SELFHEAL] 补 -NoDuplicate（已在跑就别再起一个抢端口），
        # 并把子进程输出落盘 —— 之前没落盘，出问题时只看到「拉起来了」，
        # 看不到它为什么没活下来。
        $launchLog = Join-Path $LogDir ('bridge-launch-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$Starter,'-Yes','-NoDuplicate','-LogFile',$bridgeLog) -WindowStyle Hidden -RedirectStandardOutput $launchLog -RedirectStandardError ($launchLog + '.err')
    } catch {
        Write-Log 'ERROR' ('launch failed: ' + $_.Exception.Message)
    }
    exit 0
}

# --- 3. 端口被占但健康检查不通：多半是进程卡死，走安全重启 ------------
Write-Log 'RESTART' 'port held but health check failed -> safe restart via bridge'
Write-Action 'down' 'safe-restart'
try {
    $body = @{ prompt = 'watchdog-safe-restart'; mode = 'restart-bridge' } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $Port + '/v1/images/generations') -Body $body -ContentType 'application/json' -TimeoutSec 25 | Out-Null
    Write-Log 'RESTART' 'scheduled (see run\bridge-restart.log)'
} catch {
    Write-Log 'RESTART' ('safe restart channel unavailable: ' + $_.Exception.Message)
}
exit 0

