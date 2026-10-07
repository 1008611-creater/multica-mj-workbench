/**
 * MJ 单次生图的命令行入口（改造副本）
 *
 * 来源: E:\codex\niannianai\zhuanhuiyuangong\infinite-canvas\tools\mj-bridge\mj_run.js
 * 改造:
 *   1. 默认适配器路径指向本目录的改造副本 mxai_adapter.js（可用 MXAI_ADAPTER_PATH 覆盖）
 *   2. 先加载 _deps.js，让 playwright 从原项目 node_modules 解析
 *   3. 回传 rejected / status，把「生成成功但图不合格」和「真失败」区分开
 *
 * 被 FastAPI 服务以子进程方式调用，stdout 只输出一行 JSON 结果，
 * 供 Python 侧解析。所有过程日志走 stderr，避免污染结果通道。
 *
 * 用法：
 *   node mj_run.js --prompt "..." --aspect 9:16 --out-dir <dir> [--version v8.2] [--timeout 300000]
 *
 * 输出（stdout，单行 JSON）：
 *   {"ok":true,"status":"ok","images":["...png"],"recordId":"serial-..."}
 *   {"ok":false,"status":"download_failed","rejected":[...],"error":"..."}
 *   {"ok":false,"status":"need_login","error":"..."}
 *
 * 退出码：0 成功 / 1 参数错 / 2 未登录 / 3 运行异常 / 4 找不到适配器
 */

require('./_deps.js');

const path = require('path');
const fs = require('fs');

// 免费维护通道（补下载/自检）复用同一套质量闸门，保证判定标准与出图路径完全一致。
const { inspectFile, describe: describeImg } = require(path.join(__dirname, 'verify_result.js'));

// 适配器内部大量使用 console.log，必须在加载它之前把日志改道到 stderr，
// 否则 stdout 上除了结果 JSON 还会混入日志，Python 侧解析会失败。
const toStderr = (...args) =>
    process.stderr.write(args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ') + '\n');
console.log = toStderr;

// 默认指向本目录下的改造副本；可用 MXAI_ADAPTER_PATH 覆盖。
const requestedLockWaitMs = Number(process.env.MXAI_LOCK_WAIT_MS || 0);
// Batch policy requires queued jobs to keep their slots through one full bridge task.
// Clamp stale inherited environments so an old 180/300s value cannot reintroduce lock failures.
process.env.MXAI_LOCK_WAIT_MS = String(Math.max(1200000, requestedLockWaitMs || 0));

const ADAPTER_PATH =
    process.env.MXAI_ADAPTER_PATH || path.join(__dirname, 'mxai_adapter.js');

let MxaiAdapter = null;
let adapterError = '';
try {
    MxaiAdapter = require(ADAPTER_PATH);
} catch (error) {
    adapterError = `找不到 MJ 适配器（${ADAPTER_PATH}）：${error && error.message}`;
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        if (!key.startsWith('--')) continue;
        const name = key.slice(2);
        const next = argv[index + 1];
        if (!next || next.startsWith('--')) {
            args[name] = 'true';
            continue;
        }
        args[name] = next;
        index += 1;
    }
    return args;
}

function emit(payload) {
    process.stdout.write(JSON.stringify(payload));
}

/**
 * 免费维护通道（不出图、不消耗积分）—— 让上层服务与人工排查都能在不重新生成的前提下
 * 补下载已出好的图、读回页面真实状态。这是「失败时不要盲目重跑（会重复扣费）」红线的落地。
 *
 * 用法：
 *   node mj_run.js --mode probe
 *   node mj_run.js --mode dl-serial --serial 2098540373688193024 --prefix M04_wumingkong [--archive-dir <dir>]
 *
 * stdout 仍是单行 JSON，退出码：0 成功 / 1 参数错 / 2 未登录或找不到该 serial / 4 补下载失败 / 5 拿到图但校验不过。
 */
/**
 * 【2026-09-12 缺陷 I】本地缓存探测。
 * 实测：站点对同一条 serial 的「下载」按钮是一次性的 —— 第一次点会发网络请求并生成 Blob，
 * 之后再点同一个 serial 的「下载」，站点一个请求都不发、也不触发 download 事件。
 * 所以「重试补下载」这条路在站点侧根本不成立，正确做法是：下载成功立刻归档，之后只读本地。
 * 这里在启动浏览器之前先查归档目录与输出目录，命中就直接返回，省掉一整轮浏览器往返。
 */
function probeLocalCache(prefix, dirs, serialNum) {
    const exts = ['png', 'jpg', 'jpeg', 'webp'];
    // 先按 prefix 精确找；再按 serial 号模糊找 —— 重试同一张图时 prefix 可能变了，
    // 但 serial 是不变的，用它兜底才不会重复走一遍浏览器。
    for (const dir of dirs) {
        if (!dir) continue;
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { continue; }
        // 依次尝试 <prefix>.<ext> 与 <prefix>_hi.<ext>（快车道落盘用的是后者）。
        for (const ext of exts) {
            for (const cand of [prefix + '.' + ext, prefix + '_hi.' + ext]) {
                if (!names.includes(cand)) continue;
                const full = path.join(dir, cand);
                try {
                    const info = inspectFile(full, { minW: 0, minH: 0 });
                    if (info && info.ok) return { hit: true, file: full, info, via: 'prefix' };
                } catch (e) { /* 忽略 */ }
            }
        }
        if (!serialNum) continue;
        for (const n of names) {
            if (!n.includes(serialNum)) continue;
            if (!/\.(png|jpe?g|webp)$/i.test(n)) continue;
            const cand = path.join(dir, n);
            try {
                const info = inspectFile(cand, { minW: 0, minH: 0 });
                if (info && info.ok) return { hit: true, file: cand, info, via: 'serial' };
            } catch (e) { /* 忽略 */ }
        }
    }
    return { hit: false };
}

async function runMaintenance(args) {
    // mode 支持内联参数：服务层只会透传一个 --mode 值，因此允许写成
    //   --mode probe
    //   --mode dl-serial:<serial数字id>[:<输出基名>]
    // 同时保留独立的 --serial / --prefix 参数供命令行直接调用。
    const modeSpec = String(args.mode || '').split(':');
    const mode = modeSpec[0];
    const inlineSerial = modeSpec[1] || '';
    const inlinePrefix = modeSpec.slice(2).join(':') || '';
    const outputDir = path.resolve(args['out-dir'] || process.env.MJ_OUTPUT_DIR || path.join(__dirname, '..', 'output'));
    fs.mkdirSync(outputDir, { recursive: true });
    // 维护通道也可能需要提示词（如后台出图），这里统一取一次，避免作用域缺失。
    const prompt = String(args.prompt || '').trim();
    const minW = Number(args['min-w'] || process.env.MJ_MIN_DIM || 1024);
    const minH = Number(args['min-h'] || process.env.MJ_MIN_DIM || 1024);
    const opts = { minW, minH };

    // 【2026-09-12 诊断】只读环境探针：不启动浏览器、不出图、不扣积分。
    // 用途：确认「正在跑的桥」到底传了什么超时，以及这个子进程有没有进程创建权限。
    if (mode === 'env') {
        let canSpawn = null;
        try {
            const { spawnSync } = require('child_process');
            const probe = spawnSync('cmd.exe', ['/c', 'echo ok'], { encoding: 'utf8', timeout: 8000 });
            canSpawn = {
                error: probe.error ? String(probe.error.code || probe.error.message) : null,
                status: probe.status,
                stdout: String(probe.stdout || '').trim().slice(0, 40),
            };
        } catch (error) {
            canSpawn = { threw: String((error && error.code) || (error && error.message) || error).slice(0, 120) };
        }
        const envMap = {};
        for (const key of Object.keys(process.env).filter((k) => /^(MJ_|MXAI_)/.test(k)).sort()) envMap[key] = process.env[key];
        const info = {
            argv: process.argv.slice(2),
            node: process.version,
            cwd: process.cwd(),
            timeoutFlag: args.timeout || null,
            envTimeout: process.env.MJ_BRIDGE_TIMEOUT_MS || null,
            env: envMap,
            canSpawn,
        };
        emit({ ok: true, status: 'env', message: 'ENV ' + JSON.stringify(info) });
        process.exitCode = 0;
        return;
    }

    // 【2026-09-12 运维】只读：列出占用指定端口的进程 PID。默认 8765。
    if (mode === 'netstat') {
        const port = String(modeSpec[1] || args.port || process.env.MJ_BRIDGE_PORT || '8765');
        const { spawnSync } = require('child_process');
        const res = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 20000 });
        const rows = String(res.stdout || '').split(/\r?\n/)
            .map((line) => line.trim()).filter((line) => line.includes(':' + port + ' ') && /LISTENING/i.test(line));
        const pids = [...new Set(rows.map((line) => line.split(/\s+/).pop()))];
        emit({ ok: true, status: 'netstat', port, pids, rows, message: 'NETSTAT ' + JSON.stringify({ port, pids }) });
        process.exitCode = 0;
        return;
    }

    // 【2026-09-12 运维】只读：语法自检。不出图、不启动浏览器、不扣积分。
    // 为什么需要：改完脚本没法立刻验证，一个多余的括号就能让无人值守重启静默失效。
    if (mode === 'lint') {
        const { spawnSync } = require('child_process');
        const root = path.resolve(__dirname, '..');
        const picked = (modeSpec.slice(1).join(':') || args.file || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
        const files = picked.length ? picked.map((f) => path.resolve(root, f)) : [
            path.join(__dirname, 'server.py'),
            path.join(__dirname, 'mj_run.js'),
            path.join(__dirname, 'mxai_adapter.js'),
            path.join(__dirname, 'dl_by_serial.js'),
            path.join(__dirname, 'prompt_guard.js'),
            path.join(root, 'start_mj_bridge.ps1'),
            // 【2026-09-12 稳定性】自启与看护脚本也必须过语法体检：
            // 它们是「桥自己能不能起来」的最后一道保险，坏掉不会有人察觉。
            path.join(__dirname, 'watchdog_mj_bridge.ps1'),
            path.join(__dirname, 'install_autostart.ps1'),
            // 【2026-09-14.4】免管理员自启（登录启动项 + 常驻看护循环）也必须过体检：
            path.join(__dirname, 'install_autostart_user.ps1'),
            path.join(__dirname, 'watchdog_loop.ps1'),
            // 【2026-09-12】出图前自检脚本也要过体检：它是「能不能出图」的第一道人工闸门。
            path.join(__dirname, 'preflight_check.ps1'),
        ];
        const results = [];
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            // 【2026-09-12.6】PowerShell 5.1 把「无 BOM 的 UTF-8」按本地代码页解码，
            // 中文注释会变乱码并被误报成语法错误。实测：同一文件加 BOM 即通过。
            // 这类问题肉眼看不出来（编辑器显示正常），必须在自检里显式拦下。
            if (ext === '.ps1') {
                const head = fs.readFileSync(file);
                const hasBom = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
                if (!hasBom) { results.push({ file, ok: false, error: 'missing_bom', hint: 'UTF-8 with BOM required for PowerShell 5.1' }); continue; }
            }
            if (!fs.existsSync(file)) { results.push({ file, ok: false, error: 'not_found' }); continue; }
            let res = null;
            if (ext === '.py') {
                const pythonBin = process.env.MJ_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
                res = spawnSync(pythonBin, ['-m', 'py_compile', file], { encoding: 'utf8', timeout: 60000 });
            } else if (ext === '.js') {
                res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60000 });
            } else if (ext === '.ps1') {
                // 用官方解析器查语法，不执行脚本本体（不会启动任何服务）。
                const quoted = file.replace(/'/g, "''");
                const script = "$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + quoted + "',[ref]$t,[ref]$e); if ($e.Count) { $e | ForEach-Object { Write-Output ($_.Extent.StartLineNumber.ToString() + ':' + $_.Message) }; exit 1 } else { Write-Output 'syntax-ok' }";
                res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
            } else {
                results.push({ file, ok: true, skipped: 'unknown_ext' });
                continue;
            }
            const out = String(res.stdout || '').trim();
            const err = String(res.stderr || '').trim();
            const ok = res.status === 0;
            results.push({ file, ok, status: res.status, out: out.slice(0, 500), err: err.slice(0, 500) });
        }
        const failed = results.filter((r) => !r.ok);
        emit({ ok: failed.length === 0, status: failed.length ? 'lint_failed' : 'lint_ok', results,
               message: 'LINT ' + JSON.stringify({ failed: failed.map((r) => r.file) }) });
        process.exitCode = failed.length ? 1 : 0;
        return;
    }


    // 【2026-09-12 稳定性】只读：开机自启与看护状态。不启动浏览器、不出图、不扣积分。
    // 用途：装完自启后确认两个计划任务真的注册了、看护最近有没有动作，
    //       不用去翻任务计划程序界面，也不必让用户回报。
    if (mode === 'autostart') {
        const { spawnSync } = require('child_process');
        const root = path.resolve(__dirname, '..');
        const logDir = path.join(root, 'run', 'logs');
        const names = ['MJ-Bridge-Autostart', 'MJ-Bridge-Watchdog'];
        const tasks = [];
        for (const name of names) {
            const probe = "$n='" + name + "'; $t=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; if ($t) { $i=Get-ScheduledTaskInfo -TaskName $n; Write-Output ('REGISTERED|' + $t.State + '|' + $i.LastRunTime + '|' + $i.LastTaskResult) } else { Write-Output 'MISSING' }";
            const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8', timeout: 30000 });
            const line = String(res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
            const parts = line.split('|');
            if (parts[0] === 'REGISTERED') {
                tasks.push({ name, registered: true, state: parts[1] || null, lastRun: parts[2] || null, lastResult: parts[3] || null });
            } else {
                tasks.push({ name, registered: false, error: String(res.stderr || '').trim().slice(0, 200) || null });
            }
        }
        let watchdogState = null;
        try { watchdogState = JSON.parse(fs.readFileSync(path.join(logDir, 'watchdog-state.json'), 'utf8')); } catch (error) { watchdogState = null; }
        let watchdogLogTail = [];
        try { watchdogLogTail = fs.readFileSync(path.join(logDir, 'watchdog.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-8); } catch (error) { watchdogLogTail = []; }
        const installed = tasks.every((item) => item.registered);
        emit({ ok: true, status: 'autostart', installed, tasks, watchdogState, watchdogLogTail, logDir,
               message: 'AUTOSTART ' + JSON.stringify({ installed, tasks: tasks.map((item) => item.name + '=' + (item.registered ? item.state : 'MISSING')) }) });
        process.exitCode = 0;
        return;
    }

    // 【2026-09-12.8 免费】提示词安全扫描：只读本地 .md，不联网、不出图、不扣积分。
    // 为什么需要：v8.2 解析器会把正文里的全大写缩写/连字符词误判成未知参数而整单失败，
    // 白等十几分钟。提交前先扫一遍，把风险词换成纯中文写法。
    if (mode === 'lint-prompt') {
        const guard = require(path.join(__dirname, 'prompt_guard.js'));
        const inline = modeSpec.slice(1).join(':');
        const target = path.resolve(inline || args.file || path.join(__dirname, '..', '..', 'projects'));
        const mdFiles = [];
        const walk = (dir, depth) => {
            if (depth > 6) return;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { return; }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (!/node_modules|^\.git$|^archive$|^run$/.test(entry.name)) walk(full, depth + 1); }
                else if (/\.md$/i.test(entry.name)) mdFiles.push(full);
            }
        };
        let stat = null;
        try { stat = fs.statSync(target); } catch (error) { stat = null; }
        if (stat && stat.isFile()) mdFiles.push(target);
        else if (stat && stat.isDirectory()) walk(target, 0);
        const files = [];
        let dirty = 0;
        // 【2026-09-12.9】英文「参考备份版」块单独汇总：只提示、不计入 dirty。
        const referenceWords = [];
        // 【2026-09-13】内容审查风险汇总：只提示、不计入 dirty。
        // 为什么：平台内容过滤会把「不要 X」里的 X 照样命中，实测 M03/M04 因此被判生成失败。
        // 这类风险必须让人看见，但不该把整份历史卡都判红。
        const contentRiskWords = [];
        const contentRiskFiles = [];
        for (const file of mdFiles) {
            let md = '';
            try { md = fs.readFileSync(file, 'utf8'); } catch (error) { continue; }
            const report = guard.scanMarkdown(md);
            if (report.reference && report.reference.words) {
                for (const word of report.reference.words) if (referenceWords.indexOf(word) === -1) referenceWords.push(word);
            }
            if (report.contentRisks && report.contentRisks.length) {
                const words = [];
                for (const finding of report.contentRisks) if (words.indexOf(finding.word) === -1) words.push(finding.word);
                for (const word of words) if (contentRiskWords.indexOf(word) === -1) contentRiskWords.push(word);
                contentRiskFiles.push({ file, words });
            }
            if (report.ok) continue;
            dirty += 1;
            const words = [];
            for (const finding of report.findings) if (words.indexOf(finding.word) === -1) words.push(finding.word);
            files.push({ file, blocks: report.blocks, total: report.total, words });
        }
        const payload = { ok: dirty === 0, status: dirty ? 'lint_prompt_dirty' : 'lint_prompt_clean',
            target, scanned: mdFiles.length, dirty, files, referenceWords,
            contentRiskWords, contentRiskFiles,
            message: 'PROMPT_LINT ' + JSON.stringify({ scanned: mdFiles.length, dirty, referenceWords: referenceWords.length, contentRisk: contentRiskWords.length, files: files.map((f) => f.file) }) };
        emit(payload);
        process.exitCode = dirty ? 2 : 0;
        return;
    }
    // 【2026-09-12 稳定性】后台作业模式：把一次真实出图丢给游离进程去做，
    // 立刻返回作业号。为什么需要：MJ 本机队列实测约 11 分钟，远超一次 HTTP 调用的
    // 合理等待时间；若调用方中途断开，出图仍会继续，但结果就没人收。
    // 交给游离进程后，调用方随时可以用 job:<前缀> 回来查结果，不丢单、不重复扣费。
    if (mode === 'bg') {
        const prefix = String(inlinePrefix || inlineSerial || args.prefix || ('mj_' + Date.now())).replace(/[\\/:*?"<>|]/g, '_');
        const root = path.resolve(__dirname, '..');
        const jobsDir = path.resolve(process.env.MJ_JOBS_DIR || path.join(root, 'run', 'jobs'));
        try { fs.mkdirSync(jobsDir, { recursive: true }); } catch (e) { /* ignore */ }
        const resultFile = path.join(jobsDir, prefix + '.json');
        const logFile = path.join(jobsDir, prefix + '.log');
        if (!prompt) {
            emit({ ok: false, status: 'bad_request', error: 'bg 模式必须提供 prompt' });
            process.exitCode = 1;
            return;
        }
        const { spawn } = require('child_process');
        const outFd = fs.openSync(resultFile, 'w');
        const errFd = fs.openSync(logFile, 'a');
        const child = spawn(process.execPath, [
            __filename,
            '--mode', 'normal',
            '--prompt', prompt,
            '--source-prompt', String(args['source-prompt'] || prompt),
            '--params-json', String(args['params-json'] || '{}'),
            '--aspect', String(args.aspect || '9:16'),
            '--out-dir', outputDir,
            '--prefix', prefix,
            '--output-name', String(args['output-name'] || args.outputName || args.prefix || prefix),
            '--task-id', prefix,
            '--version', String(args.version || 'v8.2'),
            '--timeout', String(args.timeout || process.env.MJ_BRIDGE_TIMEOUT_MS || '1200000'),
        ], { detached: true, stdio: ['ignore', outFd, errFd], cwd: __dirname, env: process.env, windowsHide: true });
        child.unref();
        try { fs.closeSync(outFd); } catch (e) { /* ignore */ }
        try { fs.closeSync(errFd); } catch (e) { /* ignore */ }
        emit({ ok: true, status: 'bg_started', jobId: prefix, pid: child.pid, resultFile, logFile,
               aspect: String(args.aspect || '9:16'),
               message: 'BG_STARTED ' + JSON.stringify({ jobId: prefix, pid: child.pid, resultFile }) });
        process.exitCode = 0;
        return;
    }

    // 查询后台作业结果：只读文件，不出图、不扣积分。
    if (mode === 'job') {
        const prefix = String(inlinePrefix || inlineSerial || args.prefix || '').replace(/[\\/:*?"<>|]/g, '_');
        const root = path.resolve(__dirname, '..');
        const jobsDir = path.resolve(process.env.MJ_JOBS_DIR || path.join(root, 'run', 'jobs'));
        const resultFile = path.join(jobsDir, prefix + '.json');
        const logFile = path.join(jobsDir, prefix + '.log');
        let raw = '';
        try { raw = fs.readFileSync(resultFile, 'utf8').trim(); } catch (e) { raw = ''; }
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
        const running = !parsed;
        let logTail = '';
        try {
            const lg = fs.readFileSync(logFile, 'utf8');
            logTail = lg.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ').slice(-600);
        } catch (e) { logTail = ''; }
        emit({ ok: true, status: running ? 'bg_running' : 'bg_done', jobId: prefix,
               resultFile, logFile, logTail, result: parsed,
               message: (running ? 'BG_RUNNING ' : 'BG_DONE ') + JSON.stringify({ jobId: prefix, logTail }) });
        process.exitCode = 0;
        return;
    }
    // 【2026-09-12 运维】重启桥（第一步：调度）。
    // 为什么拆两步：真正执行重启时要把旧桥杀掉，而旧桥正是当前请求的处理者，
    // 一旦在同一个进程里杀，HTTP 响应就永远发不出去，调用方只能看到「连接被重置」。
    // 所以这里只做快速预检 + 派生一个游离助手进程，立刻把结果回给调用方；
    // 杀进程与重新拉起交给助手在后台完成，过程全部写进 run/bridge-restart.log。
    if (mode === 'restart-bridge') {
        const port = String(args.port || process.env.MJ_BRIDGE_PORT || '8765');
        const canaryPort = String(args['canary-port'] || '8766');
        const root = path.resolve(__dirname, '..');
        const serverPy = path.join(__dirname, 'server.py');
        const { spawnSync, spawn } = require('child_process');
        const logPath = path.join(root, 'run', 'bridge-restart.log');
        try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (e) { /* ignore */ }

        // 预检 1：python 能不能起来、依赖在不在。
        const pyCheck = spawnSync('python', ['-c', 'import fastapi, uvicorn; print("deps-ok")'], { encoding: 'utf8', timeout: 60000 });
        const pyOk = pyCheck.status === 0 && /deps-ok/.test(String(pyCheck.stdout || ''));
        // 预检 2：server.py 语法是否有效（改坏了就别动线上）。
        const synCheck = spawnSync('python', ['-m', 'py_compile', serverPy], { encoding: 'utf8', timeout: 60000 });
        const synOk = synCheck.status === 0 && fs.existsSync(serverPy);
        if (!pyOk || !synOk) {
            emit({ ok: false, status: 'preflight_failed', pyOk, synOk, serverPy, log: logPath,
                   message: 'PREFLIGHT ' + JSON.stringify({ pyOk, synOk }) });
            process.exitCode = 1;
            return;
        }

        // 派生游离助手：它和桥没有父子依赖，因此杀掉旧桥不会连带杀掉自己。
        const helper = spawn(process.execPath,
            [__filename, '--mode', 'restart-bridge-apply', '--port', port, '--canary-port', canaryPort],
            { detached: true, stdio: 'ignore', cwd: __dirname, env: process.env, windowsHide: true });
        helper.unref();
        emit({ ok: true, status: 'restart_scheduled', port, canaryPort, helperPid: helper.pid, log: logPath,
               message: 'RESTART_SCHEDULED ' + JSON.stringify({ port, canaryPort, helperPid: helper.pid }) });
        process.exitCode = 0;
        return;
    }

    // 重启桥（第二步：执行）。由上面的调度派生为游离进程，与桥无父子依赖。
    // 成功与否看 run/bridge-restart.log，那里有全过程。
    if (mode === 'restart-bridge-apply') {
        const port = String(args.port || '8765');
        const canaryPort = String(args['canary-port'] || '8766');
        const root = path.resolve(__dirname, '..');
        const scriptsDir = __dirname;
        const serverPy = path.join(scriptsDir, 'server.py');
        const { spawnSync, spawn } = require('child_process');
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const logPath = path.join(root, 'run', 'bridge-restart.log');
        try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (e) { /* ignore */ }
        const log = (line) => { try { fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + line + '\r\n'); } catch (e) { /* ignore */ } };

        const origProfile = process.env.MXAI_PROFILE || path.join('E:', 'codex', 'niannianai', 'zhuanhuiyuangong', 'ai-rpa-console', '.browser-profile');
        const baseEnv = {
            MXAI_PROFILE: origProfile,
            MXAI_NODE_MODULES: process.env.MXAI_NODE_MODULES || path.join(path.dirname(origProfile), 'node_modules'),
            MXAI_ADAPTER_PATH: path.join(scriptsDir, 'mxai_adapter.js'),
            MXAI_URL: process.env.MXAI_URL || 'https://www.mxai.cn/home/?mp=mjdrawai&from=invite&invite_id=100595351#/mj',
            MXAI_HEADLESS: 'false',
            MXAI_PROXY: process.env.MXAI_PROXY || '127.0.0.1:7897',
            MJ_OUTPUT_DIR: path.join(root, 'output'),
            MJ_RECEIPTS_DIR: path.join(root, 'receipts'),
            MJ_ARCHIVE_DIR: path.join(root, 'archive'),
            MJ_MIN_BYTES: process.env.MJ_MIN_BYTES || '200000',
            MJ_MIN_DIM: process.env.MJ_MIN_DIM || '1024',
            MJ_BRIDGE_TIMEOUT_MS: '1200000',
        };

        const launch = (targetPort) => {
            const fd = fs.openSync(logPath, 'a');
            const child = spawn('python', ['-u', serverPy], {
                detached: true,
                stdio: ['ignore', fd, fd],
                cwd: scriptsDir,
                env: Object.assign({}, process.env, baseEnv, { MJ_BRIDGE_PORT: String(targetPort) }),
                windowsHide: true,
            });
            child.unref();
            try { fs.closeSync(fd); } catch (e) { /* ignore */ }
            return child.pid;
        };
        const probeHealth = async (targetPort, tries) => {
            let last = null;
            for (let attempt = 1; attempt <= tries; attempt += 1) {
                await sleep(attempt === 1 ? 3500 : 2500);
                try {
                    const resp = await fetch('http://127.0.0.1:' + targetPort + '/health');
                    const body = JSON.parse(await resp.text());
                    last = { status: resp.status, body };
                    if (body && body.bridge) return last;
                } catch (error) {
                    last = { error: String((error && error.message) || error).slice(0, 160) };
                }
            }
            return last;
        };

        log('apply start port=' + port + ' canaryPort=' + canaryPort);
        // 金丝雀：先在备用端口验证新代码真能服务，线上端口全程保持可用。
        const canaryPid = launch(canaryPort);
        const canary = await probeHealth(canaryPort, 6);
        const canaryBuild = canary && canary.body ? canary.body.bridge || null : null;
        log('canary port=' + canaryPort + ' pid=' + canaryPid + ' build=' + canaryBuild);
        if (!canaryBuild) {
            try { spawnSync('taskkill.exe', ['/PID', String(canaryPid), '/F'], { encoding: 'utf8', timeout: 20000 }); } catch (e) { /* ignore */ }
            log('canary_failed ' + JSON.stringify(canary));
            emit({ ok: false, status: 'canary_failed', canaryPort, canaryPid, canary, log: logPath });
            process.exitCode = 6;
            return;
        }

        // 正式切换：杀掉占着线上端口的老桥，再把新桥起在同一端口。
        const before = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 20000 });
        const rows = String(before.stdout || '').split(/\r?\n/)
            .map((line) => line.trim()).filter((line) => line.includes(':' + port + ' ') && /LISTENING/i.test(line));
        const oldPids = [...new Set(rows.map((line) => line.split(/\s+/).pop()).filter((v) => /^\d+$/.test(v)))];
        const killed = [];
        for (const pid of oldPids) {
            const k = spawnSync('taskkill.exe', ['/PID', pid, '/F'], { encoding: 'utf8', timeout: 20000 });
            killed.push({ pid, status: k.status });
            log('taskkill pid=' + pid + ' status=' + k.status);
        }
        await sleep(3000);

        const livePid = launch(port);
        const live = await probeHealth(port, 8);
        const build = live && live.body ? live.body.bridge || null : null;
        const timeoutMs = live && live.body ? live.body.timeoutMs || null : null;
        // 金丝雀使命完成：回收它，避免在备用端口留一个野进程。
        try { spawnSync('taskkill.exe', ['/PID', String(canaryPid), '/F'], { encoding: 'utf8', timeout: 20000 }); } catch (e) { /* ignore */ }
        log('live port=' + port + ' pid=' + livePid + ' build=' + build + ' timeoutMs=' + timeoutMs);
        emit({ ok: Boolean(build), status: build ? 'ok' : 'restart_unverified', port, canaryPort, canaryBuild, canaryPid, livePid, killed, log: logPath, build, timeoutMs, health: live,
               message: 'RESTART ' + JSON.stringify({ port, canaryBuild, build, timeoutMs, killed }) });
        process.exitCode = build ? 0 : 6;
        return;
    }

    // 【2026-09-12 缺陷 I】补下载前先看本地：站点对同一 serial 的下载按钮是幂等的，
    // 重复点击不会有任何响应，所以已归档过的图直接复用，绝不重复走一遍浏览器。
    if (mode === 'dl-serial') {
        const rawSerial = String(args.serial || inlineSerial || '').trim();
        if (rawSerial) {
            const numSerial = rawSerial.startsWith('serial-') ? rawSerial.slice('serial-'.length) : rawSerial;
            const cachePrefix = String(args.prefix || inlinePrefix || ('serial_' + numSerial)).replace(/[\\/:*?"<>|]/g, '_');
            const cacheDirs = [args['archive-dir'] || process.env.MJ_ARCHIVE_DIR, outputDir].filter(Boolean);
            const cached = probeLocalCache(cachePrefix, cacheDirs, numSerial);
            if (cached.hit) {
                console.log('[MXAI] 命中本地缓存(' + cached.via + ')，跳过下载: ' + cached.file + ' ' + describeImg(cached.info));
                emit({
                    ok: true, status: 'ok', cached: true, cachedVia: cached.via,
                    serial: 'serial-' + numSerial,
                    file: cached.file, images: [cached.file],
                    bytes: cached.info.bytes, w: cached.info.w, h: cached.info.h,
                    format: cached.info.format, sha256: cached.info.sha256,
                });
                process.exitCode = 0;
                return;
            }
        }
    }

    const adapter = new MxaiAdapter({});
    try {
        await adapter.launch();
        await adapter.navigate();
        const loggedIn = await adapter.isLoggedIn();
        if (!loggedIn) {
            emit({ ok: false, status: 'need_login', resultStatus: 'need_login', submitted: false, billed: false, chargeKnown: true, needLogin: true, error: 'MXAI 未登录，请在弹出的浏览器窗口里登录后重试' });
            process.exitCode = 2;
            return;
        }

        // 免费版本诊断：只选择并验证版本，不提交生成。
        if (mode === 'version-check') {
            let failure = null;
            try { await adapter.selectVersion(args.version || 'v8.2'); } catch (error) { failure = { message: error.message, cause: error.cause?.message }; }
            const chips = await adapter.page.evaluate(() => [...document.querySelectorAll('.tile-selector-item')].map(e => ({ text: (e.innerText || '').trim(), class: String(e.className || ''), visible: e.offsetParent !== null })));
            emit({ ok: !failure, status: 'version-check', submitted: false, billed: false, version: adapter._lastVersion || null, family: adapter._familySelection || null, failure, chips });
            process.exitCode = failure ? 6 : 0;
            return;
        }
        if (mode === 'probe') {
            const info = await adapter.page.evaluate(() => {
                const cards = Array.from(document.querySelectorAll('div[id*="serial-"]'));
                const ids = cards.map((c) => c.id).sort((a, b) => {
                    const x = BigInt(a.split('-')[1] || '0');
                    const y = BigInt(b.split('-')[1] || '0');
                    return x < y ? 1 : (x > y ? -1 : 0);
                });
                const newest = ids.length ? cards.find((c) => c.id === ids[0]) : null;
                const ownText = newest ? (newest.innerText || '') : '';
                return {
                    cardCount: cards.length,
                    newestId: ids[0] || null,
                    newestHasDownloadSpan: !!(newest && [...newest.querySelectorAll('span')].some((s) => (s.textContent || '').trim() === '下载')),
                    newestOwnFailedText: /绘图失败|生成失败|出图失败/.test(ownText),
                    newestOwnTextSample: ownText.replace(/\s+/g, ' ').slice(0, 160),
                    pageHasFailedText: /绘图失败|生成失败|出图失败/.test(document.body.innerText || ''),
                    // 站点当前用的是普通 div.item / div.selected-item，老版 Element-Plus 类名已不存在。
                    // 两种选择器都试一遍，否则探针会报空数组，让人误判成「站点改版、档位没了」。
                    versionChips: [...document.querySelectorAll('.tile-selector-item')]
                        .filter(e => e.children.length <= 1 && /^(?:v|nj|niji)\s*\d+(?:\.\d+)?$/i.test((e.innerText || '').trim()))
                        .map(e => ({ text: (e.innerText || '').trim(), class: String(e.className || ''), visible: e.offsetParent !== null,
                            parentClass: String(e.parentElement?.className || ''), selected: /selected|active/i.test(String(e.className || '')) })).slice(0, 30),
                    aspectChips: (() => {
                        const ep = Array.from(document.querySelectorAll('.el-radio-button__inner, .el-segmented__item'))
                            .map((e) => (e.textContent || '').trim()).filter(Boolean);
                        if (ep.length) return ep.slice(0, 12);
                        return [...document.querySelectorAll('*')]
                            .filter((e) => e.children.length === 0 && /^(1:1|1:2|16:9|9:16|4:3|3:4|3:2|2:3)$/.test((e.textContent || '').trim()))
                            .map((e) => (e.textContent || '').trim())
                            .slice(0, 12);
                    })(),
                    // 当前选中的那一档：站点给选中项加 selected-item 类，直接读出来比猜更可靠。
                    aspectSelected: (() => {
                        const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0
                            && /^(1:1|1:2|16:9|9:16|4:3|3:4|3:2|2:3)$/.test((e.textContent || '').trim())
                            && /selected|active/i.test((e.className || '').toString()));
                        return el ? (el.textContent || '').trim() : null;
                    })(),
                    url: location.href,
                    newestImgCount: newest ? newest.querySelectorAll('img').length : 0,
                    newestSpans: newest ? [...newest.querySelectorAll('span')].map((s) => (s.textContent || '').trim()).filter(Boolean).slice(0, 20) : [],
                    newestImgSrcs: newest ? [...newest.querySelectorAll('img')].map((i) => (i.currentSrc || i.src || '').slice(0, 120)).slice(0, 6) : [],
                    cards: cards.map((c) => ({
                        id: c.id,
                        failed: /绘图失败|生成失败|出图失败/.test(c.innerText || ''),
                        text: (c.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
                    })).slice(0, 12),
                    credits: (() => {
                        const m = (document.body.innerText || '').match(/[^\n]{0,30}(积分|点数|余额)[^\n]{0,30}/g);
                        return m ? m.slice(0, 6) : [];
                    })(),
                    bodyTextSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
                    newestFullText: newest ? (newest.innerText || '').replace(/\s+/g, ' ') : '',
                    notices: [...document.querySelectorAll('.el-message, .el-notification, .el-message-box, .el-alert, [class*="toast"], [class*="notice"]')]
                        .map((e) => ((e.className || '') + ' :: ' + (e.innerText || '').replace(/\s+/g, ' ')).slice(0, 300))
                        .slice(0, 10),
                    arChips: [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^(1:1|1:2|16:9|9:16|4:3|3:4|3:2|2:3)$/.test((e.textContent || '').trim()))
                        .map((e) => ({ t: (e.textContent || '').trim(), cls: (e.className || '').toString().slice(0, 70) })).slice(0, 20),
                };
            });
            // message 里再放一份紧凑 JSON：服务层会把非图片结果包成 502 detail，
            // 只有 error/message 字段能被上层读到，否则探针数据会丢在中间层。
            emit({ ok: true, status: 'probe', probe: info, message: 'PROBE ' + JSON.stringify(info) });
            process.exitCode = 0;
            return;
        }

        // 免费维护：只验证「尺寸选档」这一步是否真的点中页面档位，不出图、不扣积分。
        // 用法：--mode aspect-check:9:16   （可换 16:9 / 2:3 / 1:1 ...）
        if (mode === 'aspect-check') {
            // 注意：mode 是以 ':' 切分的，'9:16' 会被切成两段，这里必须用剩余整段拼回来。
            const want = (modeSpec.slice(1).join(':') || args.aspect || '9:16');
            const readChips = async () => await adapter.page.evaluate(() =>
                [...document.querySelectorAll('*')]
                    .filter((e) => e.children.length === 0 && /^(1:1|1:2|16:9|9:16|4:3|3:4|3:2|2:3)$/.test((e.textContent || '').trim()))
                    .map((e) => ({ t: (e.textContent || '').trim(), cls: (e.className || '').toString().slice(0, 70) }))
                    .slice(0, 20),
            ).catch(() => []);
            const before = await readChips();
            const res = await adapter.selectAspect(want);
            const after = await readChips();
            emit({
                ok: Boolean(res && res.ok),
                status: 'aspect-check',
                requested: want,
                applied: res && res.applied,
                note: res && res.note,
                chipsBefore: before,
                chipsAfter: after,
                message: 'ASPECTCHECK ' + JSON.stringify({ requested: want, res, before, after }),
            });
            process.exitCode = res && res.ok ? 0 : 6;
            return;
        }

        if (mode === 'dl-serial') {
            const raw = String(args.serial || inlineSerial || '').trim();
            if (!raw) {
                emit({ ok: false, status: 'bad_request', error: '缺少 --serial' });
                process.exitCode = 1;
                return;
            }
            const serialId = raw.startsWith('serial-') ? raw : ('serial-' + raw);
            const numId = serialId.slice('serial-'.length);
            const prefix = String(args.prefix || inlinePrefix || ('serial_' + numId)).replace(/[\\/:*?"<>|]/g, '_');

            const found = await adapter.page.evaluate((id) => !!document.getElementById(id), serialId).catch(() => false);
            if (!found) {
                emit({ ok: false, status: 'target_not_found', serial: serialId });
                process.exitCode = 2;
                return;
            }

            const result = await adapter.downloadLatestViaButton(
                outputDir, prefix, Number(args.timeout) || 180000, serialId,
            );
            const files = (result.downloaded || []).filter((f) => f && fs.existsSync(f));
            const rejected = result.rejected || [];
            if (!files.length) {
                emit({
                    ok: false,
                    status: /失败文案/.test(result.error || '') ? 'page_reported_failed' : 'download_failed',
                    serial: serialId,
                    error: result.error || '补下载未拿到文件',
                    rejected,
                });
                process.exitCode = 4;
                return;
            }

            const primary = files[0];
            const info = inspectFile(primary, opts);
            if (!info.ok) {
                emit({ ok: false, status: 'verify_failed', serial: serialId, file: primary, verdict: info.verdict, reason: info.reason, rejected });
                process.exitCode = 5;
                return;
            }

            let archived = null;
            const archiveDir = args['archive-dir'] || process.env.MJ_ARCHIVE_DIR;
            if (archiveDir) {
                fs.mkdirSync(archiveDir, { recursive: true });
                // 【2026-09-12 修复】归档扩展名必须跟真实格式走。
                // 旧代码一律写成 .png，导致 archive/ 里出现过"名叫 .png、实为 WebP"的文件
                // （mj_1a50d710.png / mj_38e16103.png，RIFF/WEBP 头，887748B）。
                // 上层按扩展名判断类型时会误判，必须按 info.format 落盘。
                const realExt = String(info.format || 'png').toLowerCase().replace('jpeg', 'jpg');
                const baseName = prefix.replace(/\.(png|jpe?g|webp)$/i, '');
                const dest = path.join(archiveDir, baseName + '.' + realExt);
                fs.copyFileSync(primary, dest);
                archived = dest;
            }

            console.log('[MXAI] 补下载成功: ' + primary + ' ' + describeImg(info));
            emit({
                ok: true,
                status: 'ok',
                serial: serialId,
                file: primary,
                // 【2026-09-12 缺陷 E】服务层只认 images 数组，单文件结果必须同时以 images 给出，
                // 否则补下载明明落盘成功，上层仍收到「第 1 张没有返回图片」的假失败。
                images: [primary],
                archived,
                bytes: info.bytes,
                w: info.w,
                h: info.h,
                format: info.format,
                sha256: info.sha256,
                rejected,
            });
            process.exitCode = 0;
            return;
        }

        emit({ ok: false, status: 'bad_request', error: '未知 --mode: ' + mode });
        process.exitCode = 1;
    } catch (error) {
        emit({ ok: false, status: 'exception', submitted: adapter._submissionStarted ? undefined : false, billed: adapter._submissionStarted ? undefined : false, error: (error && error.message) || String(error) });
        process.exitCode = 3;
    } finally {
        try {
            if (adapter && typeof adapter.close === 'function') await adapter.close();
        } catch (_) { /* ignore */ }
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const prompt = String(args.prompt || '').trim();
    if (adapterError) {
        emit({ ok: false, status: 'adapter_missing', error: adapterError });
        process.exitCode = 4;
        return;
    }
    // 免费维护通道：不出图、不消耗积分，供服务层与人工排查使用。
    if (args.mode && String(args.mode) !== 'normal') {
        return runMaintenance(args);
    }
    if (!prompt) {
        emit({ ok: false, status: 'bad_request', error: 'prompt 不能为空' });
        process.exitCode = 1;
        return;
    }

    const outputDir = path.resolve(args['out-dir'] || process.env.MJ_OUTPUT_DIR || path.join(__dirname, '..', 'output'));
    fs.mkdirSync(outputDir, { recursive: true });

    const adapter = new MxaiAdapter({});
    try {
        await adapter.launch();
        await adapter.navigate();
        const loggedIn = await adapter.isLoggedIn();
        if (!loggedIn) {
            emit({ ok: false, status: 'need_login', resultStatus: 'need_login', submitted: false, billed: false, chargeKnown: true, error: 'MXAI 未登录，请在弹出的浏览器窗口里登录后重试', needLogin: true });
            process.exitCode = 2;
            return;
        }
        const result = await adapter.generate(prompt, {
            version: args.version || 'v8.2',
            aspect: args.aspect || '9:16',
            mode: args.mode || 'normal',
            outputDir,
            filePrefix: args.prefix || args['task-id'] || `mj_${Date.now()}`,
            outputName: args['output-name'] || args.outputName || args.prefix || args['task-id'] || `生成结果_${Date.now()}`,
            // 与 MJ_BRIDGE_TIMEOUT_MS 默认值保持一致；MJ 本机队列实测 11–15 分钟，900s 会掐断。
            timeout: Number(args.timeout) || Number(process.env.MJ_BRIDGE_TIMEOUT_MS) || 1200000,
            taskId: args['task-id'] || null,
        });
        const images = Array.isArray(result && result.images)
            ? result.images.filter((file) => file && fs.existsSync(file))
            : [];
        const ok = Boolean(result && result.success) && images.length > 0;
        emit({
            ok,
            prompt: args["source-prompt"] || prompt,
            effectivePrompt: prompt,
            version: args.version || "v8.2",
            params: JSON.parse(args["params-json"] || "{}"),
            parameterVerification: "transport_only",
            status: (result && result.status) || (ok ? 'ok' : 'failed'),
            images,
            recordId: (result && result.recordId) || null,
            rejected: (result && result.rejected) || [],
            aspect: (result && result.aspect) || null,
            retryAllowed: result && typeof result.retryAllowed === 'boolean'
                ? result.retryAllowed
                : (result && typeof result.retry_allowed === 'boolean' ? result.retry_allowed : undefined),
            submitted: result && typeof result.submitted === 'boolean' ? result.submitted : undefined,
            billed: result && typeof result.billed === 'boolean' ? result.billed : undefined,
            message: (result && result.message) || undefined,
            warning: (result && result.warning) || undefined,
            error: ok ? undefined : ((result && result.message) || '生成失败，没有拿到通过校验的图片'),
        });
    } catch (error) {
        emit({ ok: false, status: 'exception',
            submitted: adapter._submissionStarted ? undefined : false,
            billed: adapter._submissionStarted ? undefined : false,
            retryAllowed: adapter._submissionStarted ? undefined : true,
            error: (error && error.message) || String(error) });
        process.exitCode = 3;
    } finally {
        // 必须显式关掉浏览器。Playwright 的子进程会让 node 挂住不退出，
        // 那样 Python 侧的 subprocess 会一直干等到超时。
        // 登录态存在 profile 目录里，关浏览器不会掉登录。
        try {
            if (adapter && typeof adapter.close === 'function') await adapter.close();
        } catch (_) {
            /* ignore */
        }
    }
}

// 不要用 process.exit()：stdout 是管道时写入是异步的，立刻退出会截断结果。
//
// 【2026-09-12 修复】原来这个 5 秒定时器写在模块顶层，等于「无论跑到哪一步，
// 5 秒后一律强杀进程」。实测后果：generate() 还在导航/等待出图时就被 exit(0)，
// stdout 一个字节都没有，Python 侧只能报 no_output —— 这就是 output\ 与
// receipts\mxai-tasks.jsonl 长期为空、管道「看起来在跑但从未出图」的真正原因。
// 现在改成：只在 main() 结束之后才挂这个兜底定时器，语义恢复为「结果已写出，
// 留 5 秒给管道刷完再强退」，正常生成过程不会被中途打断。
main()
    .then(
        () => {
            if (process.exitCode === undefined) process.exitCode = 0;
        },
        (error) => {
            process.stderr.write(String(error && error.stack || error || '维护检查意外退出') + '\n');
            if (process.exitCode === undefined) process.exitCode = 1;
        },
    )
    .finally(() => {
        setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
    });
