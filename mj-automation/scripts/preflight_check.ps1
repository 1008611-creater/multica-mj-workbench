# =====================================================================
# MJ 生图桥 · 出图前自检（只读：不出图、不扣积分、不启动浏览器）
# =====================================================================
#
# 一次跑完四道闸门，最后直接给「可以出图 / 先别出图」的结论。
# 由 4_出图前自检.cmd 调用，也可以手动跑：
#   powershell -ExecutionPolicy Bypass -File .\scripts\preflight_check.ps1
#
# 红线：本脚本只读。付费出图必须由你本人按批次授权。

$ErrorActionPreference = 'Continue'
$Bridge = 'http://127.0.0.1:8765'
$bad = 0

Write-Host ''
Write-Host 'MJ 生图桥 · 出图前自检' -ForegroundColor White
Write-Host ('=' * 62)
Write-Host '只检查，不出图、不扣积分。付费出图仍需你当次授权。' -ForegroundColor DarkGray
Write-Host ''

function Post-Bridge($body, $timeoutSec) {
    return Invoke-RestMethod -Uri ($Bridge + '/v1/maintenance') -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec $timeoutSec
}

# 第 1 道：桥在不在、代理通不通（代理不在线是最常见的整批卡死原因）
try {
    $h = Invoke-RestMethod -Uri ($Bridge + '/health') -TimeoutSec 8
} catch {
    Write-Host '   [1/4] 桥没在跑' -ForegroundColor Red
    Write-Host '         先双击 3_手动启动桥.cmd，再回来跑这个自检。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '   结论：先别出图' -ForegroundColor Red
    exit 1
}
Write-Host ('   [1/4] 桥在跑，版本 ' + $h.bridge) -ForegroundColor Green
Write-Host ('         代理 ' + $h.proxy + '  —— 必须保持开启，否则会整批卡住') -ForegroundColor DarkGray
if ($h.timeoutMs -lt 1200000) {
    Write-Host ('         注意：单次超时只有 ' + $h.timeoutMs + ' 毫秒，低于建议的 1200000；建议重启桥') -ForegroundColor Yellow
}

# 第 2 道：脚本语法（改完代码没验证就出图，是最容易白等十几分钟的坑）
try {
    $r = Post-Bridge @{ mode = 'lint' } 120
    if ($r.ok) {
        Write-Host '   [2/4] PASS  脚本语法全绿' -ForegroundColor Green
    } else {
        $bad = 1
        Write-Host '   [2/4] FAIL  脚本语法有问题，先别出图：' -ForegroundColor Red
        foreach ($x in $r.results) {
            if (-not $x.ok) {
                Write-Host ('         - ' + $x.file)
                Write-Host ('           ' + $x.error + ' ' + $x.err + ' ' + $x.out)
            }
        }
    }
} catch {
    $bad = 1
    Write-Host ('   [2/4] FAIL  语法检查没跑通：' + $_.Exception.Message) -ForegroundColor Red
}

# 第 3 道：提示词风险词。只提示、不阻断——真正的提交卡应单独过闸门。
try {
    $r = Post-Bridge @{ mode = 'lint-prompt' } 240
    if ($r.ok) {
        Write-Host ('   [3/4] PASS  提示词无风险词（扫了 ' + $r.scanned + ' 个文件）') -ForegroundColor Green
    } else {
        Write-Host ('   [3/4] 注意  有 ' + $r.dirty + ' 个文件含风险词（可能被平台误判成参数导致整单失败）：') -ForegroundColor Yellow
        foreach ($f in $r.files) {
            Write-Host ('         - ' + $f.file)
            Write-Host ('           风险词: ' + ($f.words -join ', ')) -ForegroundColor Yellow
        }
        Write-Host '         只影响直接复制这些块。提交卡已单独过闸门时，可以先出图。' -ForegroundColor DarkGray
    }
} catch {
    Write-Host ('   [3/4] 注意  提示词扫描没跑通：' + $_.Exception.Message) -ForegroundColor Yellow
}

# 第 4 道：尺寸档位（历史上出现过请求 9:16、实际点成 1:2，图出来才发现）
try {
    $r = Post-Bridge @{ mode = 'aspect-check:9:16' } 240
    if ($r.ok -and $r.applied -eq '9:16') {
        Write-Host ('   [4/4] PASS  尺寸档位已确认选中 ' + $r.applied) -ForegroundColor Green
    } else {
        $bad = 1
        Write-Host ('   [4/4] FAIL  尺寸档位没选中，先别出图：' + ($r | ConvertTo-Json -Compress)) -ForegroundColor Red
    }
} catch {
    $bad = 1
    Write-Host ('   [4/4] FAIL  尺寸检查失败：' + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ''
if ($bad -eq 0) {
    Write-Host '   结论：可以出图（每一批仍需你当次授权）' -ForegroundColor Green
} else {
    Write-Host '   结论：先别出图，把上面的 FAIL 解决掉' -ForegroundColor Red
}
Write-Host ''
