/**
 * =====================================================================
 * 【改造副本】Codex 于 2026-09-11 复制并改造，原文件保持只读不动。
 * 来源: E:/codex/niannianai/zhuanhuiyuangong/ai-rpa-console/mxai_adapter.js
 *
 * 本副本修掉审计报告里的四处断点：
 *   (1) selectAspect  —— 页面尺寸实为八档（1:1 / 1:2 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3，
 *                        2026-09-12 探针实测），9:16 可直选；点完回读选中态，选不中明确返回 ok:false。
 *   (2) downloadLatestViaButton —— 下载到的文件必须过内容校验（格式/尺寸/字节），
 *                        不合格不算成功，继续走灯箱兜底；全部失败返回 ok:false。
 *   (3) generate —— 删除“无图就回退缩略图仍报成功”的静默降级；
 *                        并在点「生成」前校验档位（不一致抛 ASPECT_NOT_APPLIED，不扣费）。
 *   (4) 记账 —— 每次生成结束（成功或失败）向 receipts/mxai-tasks.jsonl 追加一行。
 * =====================================================================
 */
/**
 * MXAI 适配器 - 通过 Playwright 自动化操作 MXAI 生图页面
 * 
 * 功能：
 * - 启动持久化浏览器（保存登录态）
 * - 检查登录状态
 * - 粘贴提示词 + 设置参数 + 点击生成
 * - 轮询等待生成完成
 * - 下载生成的图片
 * 
 * 不绕过验证码/风控，遇到时抛出异常通知用户手动处理
 */

// 依赖解析补丁必须先于 playwright 的 require 加载：
// 本目录没有 node_modules，playwright 1.62.1 装在原项目的 node_modules 里，
// _deps.js 会把它追加为模块解析路径。这样无论是 mj_run.js 调用，
// 还是直接 `node mxai_adapter.js` 自己跑（登录自检、诊断），都能解析到 playwright。
require('./_deps.js');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  const hint = process.env.MXAI_NODE_MODULES
    || 'E:/codex/niannianai/zhuanhuiyuangong/ai-rpa-console/node_modules';
  throw new Error(
    `加载 playwright 失败: ${error && error.message}。`
    + `请确认 MXAI_NODE_MODULES 指向已安装 playwright 的 node_modules（当前: ${hint}）。`
  );
}
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { inspectFile, describe: describeImg } = require(path.join(__dirname, 'verify_result.js'));

// ---------------------------------------------------------------------------
// 跨进程浏览器锁（缺陷 F 修复，2026-09-12）
// FastAPI 并发处理请求时，两个 Node 子进程会用同一个 Edge profile 同时调用
// launchPersistentContext；Chromium 规定一个 profile 同一时刻只能被一个实例持有，
// 后启动者会把先启动者的页面顶掉，先启动方中途报 Target page/context/browser closed。
// 这里用文件锁（原子 wx 创建）把「启动浏览器 -> 出图/下载 -> 关闭浏览器」整段串行化。
// ---------------------------------------------------------------------------
const LOCK_FILE = process.env.MXAI_LOCK_FILE || path.join(__dirname, '..', 'run', 'mj-browser.lock');
const LOCK_WAIT_MS = Number(process.env.MXAI_LOCK_WAIT_MS || 1200000);
const LOCK_STALE_MS = Number(process.env.MXAI_LOCK_STALE_MS || 120000);
const LOCK_HEARTBEAT_MS = Number(process.env.MXAI_LOCK_HEARTBEAT_MS || 15000);

function lockSleepMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function lockHolderAlive(holder) {
  if (!holder || !holder.pid) return false;
  try { process.kill(holder.pid, 0); return true; } catch (_) { return false; }
}

function readLockHolder() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (_) { return null; }
}

function lockIdleMs() {
  try { return Date.now() - fs.statSync(LOCK_FILE).mtimeMs; } catch (_) { return 0; }
}

function tryBreakStaleLock() {
  const holder = readLockHolder();
  const idle = lockIdleMs();
  const dead = !lockHolderAlive(holder);
  if (!dead || (!holder && idle <= LOCK_STALE_MS)) return false;
  try {
    fs.unlinkSync(LOCK_FILE);
    const why = dead ? '持有进程已退出' : ('锁静默 ' + Math.round(idle / 1000) + 's');
    console.log('[MXAI] 清理失效浏览器锁（' + why + '，pid=' + (holder && holder.pid) + '）');
    return true;
  } catch (_) { return false; }
}

let lockExitHookInstalled = false;
function installLockExitHook() {
  if (lockExitHookInstalled) return;
  lockExitHookInstalled = true;
  process.on('exit', () => {
    const holder = readLockHolder();
    if (holder && holder.pid === process.pid) {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* 忽略 */ }
    }
  });
}

const TRACE_FILE = process.env.MXAI_TRACE_FILE || path.join(__dirname, '..', 'run', 'adapter-trace.log');
function reportPhase(phase, submitted) {
  const file = process.env.MJ_PROGRESS_FILE;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ phase, at: new Date().toISOString(), submitted }));
    fs.renameSync(tmp, file);
  } catch (_) { /* receipt and job intent remain authoritative */ }
}

function trace(msg) {
  const safeMessage = String(msg)
    .replace(/https?:\/\/[^\s\"'<>]+/gi, '[url]')
    .replace(/\b(cookie|token|password|authorization|api[_-]?key|secret)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]');
  const line = new Date().toISOString() + ' [' + process.pid + '] ' + safeMessage + '\n';
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    fs.appendFileSync(TRACE_FILE, line);
  } catch (_) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 提示词尺寸参数剥离（2026-09-12 缺陷 J 修复）
//
// 实测证据：站点在生成时会把「页面档位」序列化成 --ar 追加到提示词末尾。
//   06:33 那条 serial-2098540373688193024 的站内原文结尾是
//   "--s 100 --v 8.2 --ar 1:2"，而输入的中文正文里并没有任何 --ar。
// 结论：真正决定出图比例的是「生成尺寸」档位，不是提示词里的 --ar。
// 因此提示词里再写 --ar 只会产生两个冲突来源（谁生效不确定），必须剥掉，
// 让比例只有一个权威来源 —— 页面档位。
// ---------------------------------------------------------------------------
function stripAspectParams(prompt) {
  const text = String(prompt == null ? '' : prompt);
  const removed = [];
  // 匹配 --ar 9:16 / --aspect=9:16 / --ar=9:16 / --ar 9:16 等写法
  const re = /(^|\s)--(ar|aspect)(?:\s*=\s*|\s+)(\d+\s*:\s*\d+)/gi;
  const cleaned = text.replace(re, (m, lead, name, value) => {
    removed.push('--' + name + ' ' + value.replace(/\s/g, ''));
    return lead === ' ' ? ' ' : '';
  });
  const trimmed = cleaned.replace(/\s{2,}/g, ' ').trim();
  // 极端情况：提示词只有尺寸参数，剥完为空 —— 保留原文，交给上层报错，不静默改变语义。
  if (!trimmed) return { prompt: text, removed: [] };
  return { prompt: trimmed, removed };
}

// 输出文件名只使用任务名称，不把提示词写进文件名。保留中文，清理 Windows
// 非法字符和空白，并限制长度，避免深层批次目录下超过路径上限。
function safeOutputStem(value, fallback = '生成结果') {
  const text = String(value == null ? '' : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const stem = text || fallback;
  return (/[㐀-鿿]/.test(stem) ? stem : `抽卡_${stem}`).slice(0, 80);
}

async function acquireBrowserLock(label) {
  installLockExitHook();
  const startedAt = Date.now();
  reportPhase("browser_wait", false);
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  let told = false;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, label: label || 'generate', startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      trace('lock acquired');
      reportPhase('preparing', false);
      return;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (tryBreakStaleLock()) continue;
      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        const holder = readLockHolder();
        const secs = Math.round((Date.now() - startedAt) / 1000);
        throw new Error('等待浏览器锁超时（' + secs + 's，持有者 pid=' + (holder && holder.pid) + '）。请等当前 MJ 任务结束后重试。');
      }
      if (!told) {
        told = true;
        console.log('[MXAI] 另一个 MJ 任务正在使用浏览器，排队等待锁...');
      }
      await lockSleepMs(1000);
    }
  }
}

function releaseBrowserLock() {
  try {
    const holder = readLockHolder();
    if (!holder || holder.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) { /* 文件已不存在或无权限，忽略 */ }
}
process.on('exit', (code) => trace('process.exit code=' + code));
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  try { process.on(sig, () => { trace('signal ' + sig); process.exit(124); }); } catch (_) { /* 忽略 */ }
});

class MxaiAdapter {
  constructor(options = {}) {
    // 环境变量可覆盖（便于团队成员指向各自账号/环境）：
    //   MXAI_URL      生图页地址（含各自邀请链接）
    //   MXAI_HEADLESS true/false，是否无头运行（默认 false，需本机桌面）
    //   MXAI_PROFILE  浏览器 profile 目录（默认 ./ 下的 .browser-profile）
    const envUrl = process.env.MXAI_URL;
    const envHeadless = process.env.MXAI_HEADLESS;
    const envProfile = process.env.MXAI_PROFILE;
    this.userDataDir = options.userDataDir || envProfile || path.join(__dirname, '.browser-profile');
    this.headless = options.headless !== undefined ? options.headless
      : (envHeadless === 'true' || envHeadless === '1' || envHeadless === 'yes');
    this.viewport = options.viewport || { width: 1280, height: 960 };
    this.mxaiUrl = options.mxaiUrl || envUrl
      || 'https://www.mxai.cn/home/?mp=mjdrawai&from=invite&invite_id=100595351#/mj';
    this.browser = null;
    this.context = null;
    this.page = null;
    this.lastResultId = null;
    this._lockHeld = false;
    this._lockHeartbeat = null;
    // 缺陷 G 修复（2026-09-12）：页面在点「下载」后约 1.8 秒自我关闭。
    // _blobSink 让页面把高清原图字节直接推给 Node 落盘，字节离开渲染进程后页面再关也不丢。
    this._blobSink = null;
    this._keepAlivePage = null;
    // 诊断（2026-09-12）：点击后站点到底发了哪些请求，用于定位「第二次点下载无反应」。
    this._netLog = [];
    this._dlEventCount = 0;
  }

  /**
   * 启动浏览器（持久化上下文，保存登录态）
   */
  async launch() {
    if (this.browser) return;
    await this._acquireLock();
    try {
    // 清理陈旧锁文件：脚本被强杀（/F）后 msedge 留下的 Default/LOCK 会导致
    // 新实例以 exitCode=21（profile in use）启动失败。删除 LOCK 不会丢失登录态。
    try {
      const lockFile = path.join(this.userDataDir, 'Default', 'LOCK');
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        console.log('[MXAI] 已清理陈旧 profile 锁文件 LOCK');
      }
    } catch (e) { /* 忽略 */ }

    // 确保用户数据目录存在
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: this.headless,
      viewport: this.viewport,
      channel: 'msedge',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });

    // 移除 webdriver 标记
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // 缺陷 G 修复：把页面内的 Blob 字节直接推给 Node 落盘。
    // 站点「下载」是前端把高清原图做成 Blob 再触发下载，随后页面自毁；
    // 只有让字节在自毁前离开渲染进程，成品才不会丢。
    try {
      await this.context.exposeBinding('__mjSaveBase64', async (source, payload) => {
        try {
          const sink = this._blobSink;
          if (!sink || !payload || !payload.b64) return { ok: false, error: 'no sink' };
          const type = String(payload.type || '').toLowerCase();
          const ext = /jpe?g/.test(type) ? 'jpg' : (/webp/.test(type) ? 'webp' : 'png');
          const fp = path.join(sink.outputDir, sink.prefix + '_blob.' + ext);
          const buf = Buffer.from(String(payload.b64), 'base64');
          fs.writeFileSync(fp, buf);
          sink.files.push({ file: fp, size: buf.length, type: payload.type || '' });
          trace('blob-sink wrote ' + fp + ' ' + buf.length + 'B');
          return { ok: true, size: buf.length };
        } catch (e) { trace('blob-sink err: ' + e.message); return { ok: false, error: e.message }; }
      });
    } catch (e) { trace('exposeBinding failed: ' + e.message); }

    this.page = this.context.pages()[0] || await this.context.newPage();
    // 缺陷 G 修复：持久化上下文在「最后一个页面关闭」时会整体退出。
    // 留一个空白保活页，主页面自毁时浏览器仍活着，便于收尾与排查。
    try {
      this._keepAlivePage = await this.context.newPage();
      await this._keepAlivePage.goto('about:blank', { timeout: 15000 }).catch(() => {});
      trace('keep-alive page created');
    } catch (e) { trace('keep-alive page failed: ' + e.message); }
    this.context.on('close', () => trace('CONTEXT CLOSED'));
    this.context.on('page', (np) => trace('NEW PAGE opened: ' + np.url()));
    this.page.on('close', () => trace('PAGE CLOSED'));
    this.page.on('crash', () => trace('PAGE CRASHED'));
    trace('launch ok, page url=' + this.page.url());
    this.browser = this.context; // 与 context 保持一致，供守卫判重（persistent context 无独立 browser 对象）

    // 监听对话框
    this.page.on('dialog', async (dialog) => {
      console.log(`[MXAI] 页面对话框: ${dialog.type()} - ${dialog.message()}`);
      await dialog.dismiss();
    });

    console.log('[MXAI] 浏览器已启动');
    } catch (err) {
      this._releaseLock();
      throw err;
    }
  }

  /**
   * 关闭浏览器
   */
  async close() {
    trace('close() called');
    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
        this.browser = null;
        this.page = null;
        console.log('[MXAI] 浏览器已关闭');
      }
    } catch (e) {
      this.context = null;
      this.browser = null;
      this.page = null;
      const msg = (e && e.message) || String(e);
      console.log('[MXAI] 关闭浏览器时报错（已忽略，锁照常释放）: ' + msg);
    } finally {
      this._releaseLock();
    }
  }

  // 跨进程串行化：抢到锁才允许启动浏览器（缺陷 F）
  async _acquireLock() {
    if (this._lockHeld) return;
    await acquireBrowserLock(process.env.MXAI_TASK_LABEL || 'generate');
    this._lockHeld = true;
    const beat = () => {
      try { const now = new Date(); fs.utimesSync(LOCK_FILE, now, now); } catch (_) { /* 忽略 */ }
    };
    this._lockHeartbeat = setInterval(beat, LOCK_HEARTBEAT_MS);
    if (this._lockHeartbeat && typeof this._lockHeartbeat.unref === 'function') {
      this._lockHeartbeat.unref();
    }
    console.log('[MXAI] 已获取浏览器锁 pid=' + process.pid);
  }

  _releaseLock() {
    if (this._lockHeartbeat) {
      clearInterval(this._lockHeartbeat);
      this._lockHeartbeat = null;
    }
    if (!this._lockHeld) return;
    this._lockHeld = false;
    releaseBrowserLock();
    console.log('[MXAI] 已释放浏览器锁');
  }

  /**
   * 导航到 MXAI 生图页并等待加载
   */
  async navigate(options = {}) {
    if (!this.page) await this.launch();

    console.log('[MXAI] 导航到生图页...');
    await this.page.goto(this.mxaiUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Manual login mode: navigate once and leave the page to the user.
    // Do not wait for the creation workspace or run popup cleanup here.
    if (options.waitForWorkspace === false) {
      await this.page.waitForTimeout(1200);
      console.log('[MXAI] \u767b\u5f55\u9875\u9762\u5df2\u6253\u5f00\uff0c\u7b49\u5f85\u7528\u6237\u624b\u52a8\u767b\u5f55\uff1b\u4e0d\u4f1a\u81ea\u52a8\u91cd\u8f7d\u6216\u5173\u95ed\u767b\u5f55\u5f39\u7a97');
      return;
    }

    // 等待 SPA 真正挂载出 MJ 创作面板（不是仅 DOMContentLoaded，也不是别的 tab 的隐藏 textarea）。
    // 必须等到「可见」的 .mj-left-tool 或「可见」的提示词文本域，否则后续交互会落空。
    let ready = false;
    for (let attempt = 0; attempt < 2 && !ready; attempt++) {
      try {
        await this.page.waitForFunction(() => {
          const panel = document.querySelector('.mj-left-tool');
          if (panel && panel.offsetParent !== null) return true;
          const tas = Array.from(document.querySelectorAll('textarea'));
          return tas.some(t => /输入绘画描述词/.test(t.placeholder || '') && t.offsetParent !== null);
        }, { timeout: 45000 });
        ready = true;
      } catch (e) {
        console.log('[MXAI] 创作面板未按时出现，重载重试...');
        await this.page.goto(this.mxaiUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    }
    if (!ready) {
      console.log('[MXAI] 警告: 创作面板仍未加载，继续尝试（可能页面异常）');
    }

    // 关闭可能弹出的广告/签到弹窗（首次清理）
    await this.page.waitForTimeout(1500);
    await this._dismissPopups();

    // 部分广告弹窗在加载数秒后才延迟弹出，等待后做二次清理
    await this.page.waitForTimeout(3000);
    await this._dismissPopups();

    // 再等待一轮，兜底极晚出现的弹窗
    await this.page.waitForTimeout(2000);
    await this._dismissPopups();

    // 最后再留一点沉淀时间，避免面板动画/懒加载还没完成
    await this.page.waitForTimeout(2000);

    console.log('[MXAI] 页面加载完成，弹窗已清理');
  }

  /**
   * 关闭页面上的广告/活动/签到等弹窗
   * 覆盖：活动横幅(Seedance)、el-dialog 的 X、el-drawer 的 X、各类 close 按钮、遮罩层点击关闭
   * 多轮扫描，直到没有可见弹窗为止（一个弹窗关闭后可能暴露下一个）
   */
  async _dismissPopups(maxRounds = 5) {
    if (!this.page) return { dismissed: 0 };
    const closeSelectors = [
      '.global-seedance-promo__close',          // Seedance 活动横幅关闭
      '.el-dialog__headerbtn',                  // Element UI 对话框 X
      '.el-drawer__close-btn',                  // Element UI 抽屉 X
      '[class*="promo"] [class*="close"]',
      '[class*="modal"] [class*="close"]',
      '[class*="dialog"] [class*="close"]',
      '[class*="popup"] [class*="close"]',
      '[class*="notice"] [class*="close"]',
      '[class*="close-btn"]',
      '[class*="closeBtn"]',
      'button[class*="close"]',
      'span[class*="close"]',
      'a[class*="close"]',
      'i[class*="close"]',
      '[aria-label="关闭"]',
      '[aria-label="Close"]',
      '[aria-label="close"]',
    ];
    // 仅作为兜底：文本明确的关闭动作
    const closeTexts = ['关闭', '知道了', '不再提醒', '稍后', '暂不', '×', 'Close'];
    let totalDismissed = 0;

    for (let round = 0; round < maxRounds; round++) {
      let dismissedAny = false;

      // 1) 选择器命中的可见关闭按钮
      for (const sel of closeSelectors) {
        try {
          const nodes = await this.page.locator(sel).all();
          for (const n of nodes) {
            if (await n.isVisible().catch(() => false)) {
              const tag = await n.evaluate(el => el.tagName).catch(() => '');
              // 避免误点面积巨大的容器（可能是整个遮罩而非关闭按钮）
              const box = await n.boundingBox().catch(() => null);
              const tooBig = box && (box.width > 600 || box.height > 600);
              if (tooBig) continue;
              await n.click({ timeout: 2500, force: true }).catch(() => {});
              dismissedAny = true;
              totalDismissed++;
              await this.page.waitForTimeout(450);
            }
          }
        } catch (e) { /* 忽略单条异常 */ }
      }

      // 2) 文本命中的可见关闭按钮（兜底）
      try {
        for (const t of closeTexts) {
          const nodes = await this.page.getByText(t, { exact: false }).all();
          for (const n of nodes) {
            if (await n.isVisible().catch(() => false)) {
              const tag = await n.evaluate(el => el.tagName).catch(() => '');
              if (['BUTTON', 'A', 'SPAN', 'DIV', 'I'].includes(tag)) {
                const box = await n.boundingBox().catch(() => null);
                const tooBig = box && (box.width > 600 || box.height > 600);
                if (tooBig) continue;
                await n.click({ timeout: 2500, force: true }).catch(() => {});
                dismissedAny = true;
                totalDismissed++;
                await this.page.waitForTimeout(450);
              }
            }
          }
        }
      } catch (e) { /* 忽略 */ }

      if (!dismissedAny) break;
      await this.page.waitForTimeout(600);
    }

    // 3) 点击真正的遮罩层角落（close-on-click-modal 的弹窗）。
    //    注意：排除装饰用背景图（class 含 "mask" 的 IMG，如 var(--mx-bg-mask)），避免误点。
    try {
      const backdrops = await this.page.locator('.el-overlay, [class*="overlay"]').all();
      for (const bd of backdrops) {
        const tag = await bd.evaluate(el => el.tagName).catch(() => '');
        const cls = await bd.evaluate(el => (el.className && el.className.toString ? el.className.toString() : '')).catch(() => '');
        if (/mask/i.test(cls) && !/overlay/i.test(cls)) continue; // 跳过纯装饰背景
        if (await bd.isVisible().catch(() => false)) {
          const box = await bd.boundingBox().catch(() => null);
          if (box) {
            await this.page.mouse.click(box.x + 6, box.y + 6).catch(() => {});
            totalDismissed++;
            await this.page.waitForTimeout(450);
          }
        }
      }
    } catch (e) { /* 忽略 */ }

    console.log(`[MXAI] 弹窗清理完成，共关闭 ${totalDismissed} 个`);
    return { dismissed: totalDismissed };
  }

  /**
   * 对外暴露：关闭广告弹窗（可在任意时刻调用）
   */
  async dismissAds() {
    if (!this.page) return { error: '浏览器未启动' };
    return this._dismissPopups();
  }

  /**
   * 检查是否已登录
   * @returns {boolean}
   */
  async getLoginState() {
    if (!this.page || this.page.isClosed()) return "unknown";
    try {
      const text = await this.page.evaluate(() => document.body.innerText);
      if (typeof text !== "string" || !text.trim()) return "unknown";
      const out = /\u672a\u767b\u5f55|\u8bf7\u767b\u5f55|\u7acb\u5373\u767b\u5f55|\u767b\u5f55\/\u6ce8\u518c/.test(text);
      const inside = /\d+\s*\u79ef\u5206|\u5df2\u7b7e\u5230/.test(text);
      if (inside && !out) return "logged_in";
      if (out && !inside) return "not_logged_in";
      return "unknown";
    } catch (_) { return "unknown"; }
  }

  async isLoggedIn() { return (await this.getLoginState()) === "logged_in"; }

  /**
   * 确保已登录，未登录则抛出异常
   */
  async ensureLoggedIn() {
    const loggedIn = await this.isLoggedIn();
    if (!loggedIn) {
      throw new Error(
        'MXAI 未登录。请在打开的浏览器窗口中手动登录，登录完成后重新调用。'
      );
    }
  }

  /**
   * 在输入框中粘贴提示词
   * @param {string} prompt - 提示词文本（可包含参数）
   */
  async fillPrompt(prompt) {
    // 页面文本域较多（含隐藏的「视频创意描述」等），用页内 evaluate 精确定位
    // 「可见」且 placeholder 含「输入绘画描述词」的那一个创作文本框。
    const handle = await this.page.evaluateHandle(() => {
      const tas = Array.from(document.querySelectorAll('textarea'));
      const hit = tas.find(t =>
        /输入绘画描述词/.test(t.placeholder || '') && t.offsetParent !== null);
      return hit || null;
    });
    const el = handle.asElement();
    if (!el) {
      // 诊断：存截图，dump 文本域数量
      const n = await this.page.evaluate(() => document.querySelectorAll('textarea').length).catch(() => -1);
      const hasPanel = await this.page.evaluate(() => !!document.querySelector('.mj-left-tool')).catch(() => false);
      console.error(`[MXAI] 未找到创作提示词文本域（textarea 总数=${n}, mj-left-tool=${hasPanel}）`);
      try { await this.page.screenshot({ path: path.join(__dirname, '.automation', 'debug_no_prompt.png'), fullPage: false }); } catch (e) {}
      throw new Error('未找到创作提示词文本域（页面可能未完全加载或被弹窗遮挡）');
    }

    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click();
    await this.page.keyboard.press('Control+A');
    await this.page.keyboard.press('Backspace');
    await this.page.waitForTimeout(150);
    await el.fill(prompt);

    // 校验：Vue 的 v-model 偶尔吞掉 .fill() 的输入，确认值已真正写入，否则重试
    const verify = async () => this.page.evaluate(() => {
      const tas = Array.from(document.querySelectorAll('textarea'));
      const hit = tas.find(t => /输入绘画描述词/.test(t.placeholder || '') && t.offsetParent !== null);
      return hit ? (hit.value || '').length : -1;
    });
    let vlen = await verify();
    for (let retry = 0; retry < 3 && vlen < Math.min(prompt.length, 20); retry++) {
      console.log(`[MXAI] 提示词疑似未写入(value=${vlen})，重试 ${retry + 1}/3`);
      await el.click();
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Backspace');
      await this.page.waitForTimeout(120);
      await el.fill(prompt);
      await this.page.waitForTimeout(200);
      vlen = await verify();
    }
    if (vlen < Math.min(prompt.length, 20)) {
      throw new Error('提示词填写后校验失败（v-model 未捕获输入），放弃本次生成');
    }
    console.log(`[MXAI] 提示词已输入(value=${vlen})`);
  }

  /**
   * 选择模型版本
   * @param {string} version - 如 'v8.2', 'v8.1', 'v7.0'
   */
  async selectVersion(version = 'v8.2') {
    // mxai 模型选择器是「家族」选择：Midjourney / 写实想象 / Niji / 卡通。
    // 选 Midjourney 家族即默认 v8.2（项目资产规范要的）；Niji 家族默认 NJ7.0。
    // 页面渲染文本可能被编码（如 "Mid`J"），用页内 evaluate 精确点选最稳。
    const wantNiji = /niji|nijie|尼吉|尼采/i.test(version || '');
    const kw = wantNiji ? ['niji', 'nijie', '尼吉', '尼采', 'nid`j'] : ['midjourney', 'mid`j', 'mid j', 'mj'];
    // The model header toggles the selector. Do not close already visible chips.
    const targetNumber = Number(String(version || '').trim().toLowerCase().replace(/^(?:niji|nj|v)/, '')) || (wantNiji ? 7 : 8.2);
    const chipsReady = await this.page.evaluate(({ number, niji }) =>
      [...document.querySelectorAll('.tile-selector-item')].some(e => {
        const t = (e.innerText || '').trim().toLowerCase();
        return e.offsetParent !== null && /^(?:niji|nj)/.test(t) === niji && Number(t.replace(/^(?:niji|nj|v)/, '')) === number;
      }), { number: targetNumber, niji: wantNiji });
    if (!chipsReady) {
      const clicked = await this.page.evaluate((kws) => {
        const hit = [...document.querySelectorAll('.mj-left-tool *, .mj-theme-page *')].find(e => {
          const t = (e.innerText || '').trim().toLowerCase();
          return kws.includes(t) && e.children.length <= 1 && e.offsetParent !== null &&
            e.getBoundingClientRect().width < 300 && e.getBoundingClientRect().height < 80;
        });
        if (!hit) return null;
        const info = { text: (hit.innerText || '').trim(), class: String(hit.className || '') };
        hit.click(); return info;
      }, kw);
      if (!clicked) {
        const error = new Error('无法确认模型家族，已在提交前停止'); error.code = 'VERSION_NOT_APPLIED'; throw error;
      }
      this._familySelection = clicked;
    } else {
      this._familySelection = { reusedVisibleChips: true };
    }

    const verNorm = (version || '').toString().trim().toLowerCase().replace(/^(?:niji|nj|v)/, '');
    const wantVer = wantNiji
      ? (verNorm && /^\d/.test(verNorm) ? verNorm : '7.0')   // Niji 家族默认 NJ7.0
      : (verNorm && /^\d/.test(verNorm) ? verNorm : '8.2');  // Midjourney 家族默认 v8.2
    const expected = { number: Number(wantVer), niji: wantNiji };
    // Wait for family-specific chips; ignore hidden selectors and another model family.
    try {
      await this.page.waitForFunction(({ number, niji }) => Array.from(document.querySelectorAll('.tile-selector-item')).some(e => {
        const t = (e.innerText || '').trim().toLowerCase();
        return e.offsetParent !== null && /^(?:niji|nj)/.test(t) === niji && Number(t.replace(/^(?:niji|nj|v)/, '')) === number;
      }), expected, { timeout: 5000 });
      await this.page.evaluate(({ number, niji }) => {
        const match = Array.from(document.querySelectorAll('.tile-selector-item')).find(e => {
          const t = (e.innerText || '').trim().toLowerCase();
          return e.offsetParent !== null && /^(?:niji|nj)/.test(t) === niji && Number(t.replace(/^(?:niji|nj|v)/, '')) === number;
        });
        if (match && !match.classList.contains('is-selected')) match.click();
      }, expected);
      await this.page.waitForFunction(({ number, niji }) => Array.from(document.querySelectorAll('.tile-selector-item.is-selected')).some(e => {
        const t = (e.innerText || '').trim().toLowerCase();
        return e.offsetParent !== null && /^(?:niji|nj)/.test(t) === niji && Number(t.replace(/^(?:niji|nj|v)/, '')) === number;
      }), expected, { timeout: 5000 });
    } catch (cause) {
      const error = new Error('模型版本无法精确确认，已在提交前停止：' + version);
      error.code = 'VERSION_NOT_APPLIED'; error.cause = cause; throw error;
    }
    this._lastVersion = { requested: version, applied: (wantNiji ? 'niji' : 'v') + wantVer, verified: true };
  }

  /**
   * 选择模式（普通/快速）
   * @param {string} mode - 'normal' | 'fast'
   */
  async selectMode(mode = 'normal') {
    const modeText = mode === 'fast' ? '快速' : '普通';
    const modeBtn = this.page.locator(`div:has-text("模式选择") ~ div >> text="${modeText}"`).first();
    
    try {
      await modeBtn.waitFor({ state: 'visible', timeout: 5000 });
      await modeBtn.click();
      console.log(`[MXAI] 已选择模式: ${modeText}`);
    } catch (e) {
      // 备用
      const btns = await this.page.locator(`text="${modeText}"`).all();
      for (const btn of btns) {
        try {
          if (await btn.isVisible()) {
            await btn.click();
            return;
          }
        } catch (e2) { /* 继续 */ }
      }
      console.log(`[MXAI] 警告: 无法切换模式到 ${modeText}`);
    }
  }

  /**
   * 选择生成尺寸
   * @param {string} aspect - 如 '9:16', '1:1', '16:9'
   */
  /**
   * 选择生成尺寸（中文版 MXAI 实测八档：1:1 / 1:2 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3）
   *
   * 断点一：旧版直接找 text="9:16" 的按钮，当时页面没有这一档，catch 只打警告就返回，
   *         调用方以为已设成功。
   * 断点二（2026-09-12 探针实测）：上一版误以为中文版只有四档，把 9:16 硬映射到 1:2。
   *         页面明明有 9:16 档，却被降级成 1:2 —— 直接破坏 9:16 / 1080x1920 规格约定，
   *         是「出图成功但规格全错」的根因。
   * 修法：按页面真实八档直通映射（9:16 -> 9:16），点完回读选中态，
   *       失败明确返回 ok:false；只有页面确实没有该档时才就近兜底。
   * @param {string} aspect - 期望比例，如 9:16 / 16:9 / 2:3 / 1:1
   * @returns {Promise<{ok:boolean, requested:string, applied:string|null, note:string}>}
   */
  async selectAspect(aspect = '9:16') {
    // 中文版 UI 上真实存在的八档（顺序即页面顺序，2026-09-12 探针实测）
    const UI_LABELS = ['1:1', '1:2', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
    // AR -> UI 档位：优先直通（页面有同档就选同档），不做任何降级。
    const MAP = {
      '1:1': '1:1',
      '9:16': '9:16', '2:3': '2:3', '1:2': '1:2', '4:5': '4:5',
      '16:9': '16:9', '4:3': '4:3', '3:2': '3:2', '5:4': '5:4',
      '3:4': '3:4',
    };
    // 就近兜底表：仅当页面确实没有该档时才用（如 4:5 / 5:4 中文版未提供）。
    const NEAREST = {
      '4:5': '3:4', '5:4': '4:3',
    };
    const requested = String(aspect || '').trim();
    let target = MAP[requested] || (UI_LABELS.includes(requested) ? requested : null);
    if (!target) {
      const note = `未识别的尺寸 ${requested}，可选: ${Object.keys(MAP).join(' / ')}`;
      console.log(`[MXAI] 选择尺寸跳过: ${note}`);
      this._lastAspect = { requested, applied: null, ok: false, note };
      return { ok: false, requested, applied: null, note };
    }
    // 页面没有该档时才降级，并且把降级事实写进 note，绝不静默降级。
    if (!UI_LABELS.includes(target)) {
      const fb = NEAREST[target];
      if (!fb) {
        const note = `未识别的尺寸 ${requested}，可选: ${Object.keys(MAP).join(' / ')}`;
        console.log(`[MXAI] 选择尺寸跳过: ${note}`);
        this._lastAspect = { requested, applied: null, ok: false, note };
        return { ok: false, requested, applied: null, note };
      }
      console.log(`[MXAI] 中文版无 ${target} 档，就近映射到 ${fb}`);
      target = fb;
    }

    const clickTarget = async (label) => {
      return await this.page.evaluate((lab) => {
        // 只在左侧创作面板内找，避免命中历史记录卡片上的比例字样
        const scopes = [
          document.querySelector('.mj-left-tool'),
          document.querySelector('.mj-theme-page'),
          document.body,
        ].filter(Boolean);
        for (const scope of scopes) {
          const cands = Array.from(scope.querySelectorAll('button, div, span, li, label'));
          for (const el of cands) {
            const t = (el.textContent || '').trim();
            if (t !== lab) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            if (r.width >= 160 || r.height >= 60) continue;
            el.click();
            return true;
          }
        }
        return false;
      }, label).catch(() => false);
    };

    const readSelected = async (label) => {
      return await this.page.evaluate((lab) => {
        const scope = document.querySelector('.mj-left-tool') || document.body;
        const cands = Array.from(scope.querySelectorAll('button, div, span, li, label'));
        for (const el of cands) {
          if ((el.textContent || '').trim() !== lab) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          if (r.width >= 160 || r.height >= 60) continue;
          const cls = (el.className && el.className.toString ? el.className.toString() : '') || '';
          const aria = el.getAttribute('aria-checked') || '';
          const on = /selected|active|checked|primary/i.test(cls) || aria === 'true';
          return on;
        }
        return false;
      }, label).catch(() => false);
    };

    // 主路径：精确点目标档位
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const clicked = await clickTarget(target);
      if (!clicked) {
        await this.page.waitForTimeout(500);
        continue;
      }
      await this.page.waitForTimeout(600);
      ok = await readSelected(target);
    }

    if (ok) {
      const note = requested === target
        ? `已选择尺寸 ${target}`
        : `已选择尺寸 ${target}（中文版无 ${requested} 档，就近映射）`;
      console.log(`[MXAI] ${note}`);
      this._lastAspect = { requested, applied: target, ok: true, note };
      return { ok: true, requested, applied: target, note };
    }

    // 兜底：整页再点一次（老版页面结构）
    const loose = await this.page.locator(`text="${target}"`).all().catch(() => []);
    for (const btn of loose) {
      try {
        if (!(await btn.isVisible())) continue;
        const box = await btn.boundingBox();
        if (box && box.x < 700 && box.width < 160 && box.height < 60) {
          await btn.click();
          await this.page.waitForTimeout(600);
          ok = await readSelected(target);
          if (ok) break;
        }
      } catch (e2) { /* 继续 */ }
    }

    if (ok) {
      const note = `已选择尺寸 ${target}（兜底路径）`;
      console.log(`[MXAI] ${note}`);
      this._lastAspect = { requested, applied: target, ok: true, note };
      return { ok: true, requested, applied: target, note };
    }

    const failNote = `未能选中尺寸 ${requested} -> ${target}，页面档位未发生变更`;
    console.log(`[MXAI] 警告: ${failNote}`);
    this._lastAspect = { requested, applied: null, ok: false, note: failNote };
    return { ok: false, requested, applied: null, note: failNote };
  }

  /**
   * 设置高级参数（通过点击 +/- 按钮调整数值）
   * 由于滑块没有输入框，用点击 +/- 的方式
   * @param {string} param - 'stylize' | 'chaos' | 'quality'
   * @param {number} value - 目标值
   */
  async setAdvancedParam(param, value) {
    const paramMap = {
      stylize: { label: '风格化等级', default: 100 },
      chaos: { label: '多样化等级', default: 0 },
      quality: { label: '质量化等级', default: 100 },
    };
    
    const config = paramMap[param];
    if (!config) {
      console.log(`[MXAI] 未知参数: ${param}`);
      return;
    }

    // 找到参数区域
    const paramArea = this.page.locator(`div:has-text("${config.label}")`).first();
    
    try {
      await paramArea.waitFor({ state: 'visible', timeout: 5000 });
      
      // 获取当前值（在参数区域内找数字）
      // 由于没有稳定的选择器，这里简化处理：如果目标值等于默认值则不操作
      // 实际使用中，提示词里直接写 --stylize 250 --chaos 5 更可靠
      console.log(`[MXAI] 参数 ${param} 建议通过提示词参数设置（--${param} ${value}），而非页面滑块`);
    } catch (e) {
      console.log(`[MXAI] 参数 ${param} 设置跳过: ${e.message}`);
    }
  }

  /**
   * 点击立即生成按钮
   */
  async clickGenerate() {
    const genBtn = this.page.locator('div:has-text("立即生成")').filter({ hasText: '立即生成' }).first();
    
    // 更精确：找紫色的立即生成按钮
    const buttons = await this.page.locator('text=立即生成').all();
    let clicked = false;
    
    for (const btn of buttons) {
      try {
        if (await btn.isVisible()) {
          const box = await btn.boundingBox();
          if (box && box.x < 700) { // 左侧创作区
            await btn.click();
            clicked = true;
            console.log('[MXAI] 已点击立即生成');
            break;
          }
        }
      } catch (e) { /* 继续 */ }
    }
    
    if (!clicked) {
      throw new Error('无法找到并点击立即生成按钮');
    }
  }

  /**
   * 记录当前最新的生成记录ID（用于后续判断新生成是否完成）
   */
  async _recordLatestResult() {
    try {
      // 创作中心的第一条记录（最新的）
      const firstRecord = this.page.locator('#创作中心 ~ div >> div[id*="serial-"]').first();
      const id = await firstRecord.getAttribute('id').catch(() => null);
      this.lastResultId = id;
      console.log(`[MXAI] 当前最新记录ID: ${id}`);
    } catch (e) {
      this.lastResultId = null;
    }
  }

  /**
   * 采集当前页面所有图片 src（含懒加载的 currentSrc）
   * @returns {Promise<Set<string>>}
   */
  async _collectImageSrcs() {
    try {
      const srcs = await this.page.evaluate(() =>
        Array.from(document.querySelectorAll('img'))
          .map(i => i.currentSrc || i.src || '')
          .filter(s => s && s.startsWith('http'))
      ).catch(() => []);
      return new Set(srcs);
    } catch (e) {
      return new Set();
    }
  }

  async _collectSerialIds() {
    try {
      const ids = await this.page.evaluate(() =>
        Array.from(document.querySelectorAll('div[id*="serial-"]')).map(d => d.id)
      ).catch(() => []);
      return new Set(ids);
    } catch (e) {
      return new Set();
    }
  }

  // 等待指定 serial 的图像真正渲染完成（缩略图为 qihuiai CDN 真实地址，而非 loading 占位）
  async _waitSerialRendered(id, timeout = 150000) {
    const start = Date.now();
    let lastLog = 0;
    let lastSrc = '';
    while (Date.now() - start < timeout) {
      const info = await this.page.evaluate((i) => {
        const el = document.getElementById(i);
        if (!el) return { ok: false, src: '', nw: 0, nh: 0, why: 'no el' };
        const imgs = Array.from(el.querySelectorAll('img'));
        // 取最大的那张（避免命中 logo/icon）
        const im = imgs.map(x => ({ x, s: x.currentSrc || x.src || '', w: x.naturalWidth || 0, h: x.naturalHeight || 0 }))
                       .sort((a, b) => (b.w * b.h) - (a.w * a.h))[0] || { s: '', w: 0, h: 0 };
        const ok = im.s && im.s.includes('qihuiai') && !im.s.includes('loading') && im.w > 100;
        return { ok, src: im.s, nw: im.w, nh: im.h, imgCount: imgs.length, why: ok ? '' : (im.s ? (im.s.includes('loading') ? 'loading' : 'small') : 'no img') };
      }, id).catch(() => ({ ok: false, src: '', nw: 0, nh: 0, why: 'eval err' }));
      if (info.src !== lastSrc) { lastSrc = info.src; lastLog = Date.now(); }
      if (info.ok) return { ok: true, src: info.src, w: info.nw, h: info.nh };
      // 每 20s 打一次进度
      if (Date.now() - lastLog > 20000) {
        lastLog = Date.now();
        const el = Math.round((Date.now() - start) / 1000);
        console.log(`[MXAI] 等待 serial ${id} 渲染... ${el}s src=${(info.src||'').slice(0,80)} nw=${info.nw} (${info.why})`);
      }
      await this.page.waitForTimeout(3000);
    }
    return { ok: false, src: lastSrc };
  }

  /**
   * 等待生成完成
   * 完成判定：与点击生成前基线相比出现 >=4 张新图；或出现明确的完成/失败文案。
   * @param {number} timeout - 超时时间（毫秒），默认120秒
   * @returns {object} - { success: boolean, message: string, recordId: string }
   */
  async waitForResult(timeout = 120000) {
    console.log('[MXAI] 等待生成完成...');
    const startTime = Date.now();
    const baseline = this._baselineSrcs || new Set();
    const baselineSerials = this._baselineSerials || new Set();
    const requiredNew = this._requiredNewImages || 4;
    // 【2026-09-12】「排队中」是一个真实状态，不是失败：把它单独记账，
    // 让上层能拿着 serial 走免费的 dl-serial 补下载，而不是盲目重跑（会重复扣积分）。
    let queueSeen = false;
    let queueText = '';
    let unassociatedSeen = false;

    while (Date.now() - startTime < timeout) {
      await this.page.waitForTimeout(3000);

      try {
        const srcs = await this._collectImageSrcs();
        const newSrcs = [...srcs].filter(s => !baseline.has(s));
        const serials = await this._collectSerialIds();
        const newSerials = [...serials].filter(s => !baselineSerials.has(s));
        const pageText = await this.page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');

        // 失败判定：只看「本次新 serial 卡片」内的失败文案。
        // 禁止扫全页 —— 列表里会残留历史失败卡片的旧文案，全页扫描必然误判。
        if (newSerials.length > 0) {
          const newestTmp = newSerials.slice().sort((a, b) => {
            const x = BigInt(b.split('-')[1] || '0');
            const y = BigInt(a.split('-')[1] || '0');
            return x < y ? -1 : (x > y ? 1 : 0);
          })[0];
          const ownFail = await this.page.evaluate((id) => {
            const el = document.getElementById(id);
            const t = el ? (el.innerText || '') : '';
            return t.match(/(绘图失败|生成失败|出图失败)[：:：]?\s*([^\n]{0,60})/);
          }, newestTmp).catch(() => null);
          if (ownFail) {
            const reason = (ownFail[2] || '未知原因').trim();
            console.log(`[MXAI] 生成失败（serial ${newestTmp}）: ${reason}`);
            return { success: false, status: 'page_reported_failed', message: `绘图失败：${reason}`, recordId: newestTmp };
          }
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);

        // 完成判定：出现新 serial（最可靠，mxai 4宫格常共用同一 src，按图数判定会漏）
        if (newSerials.length > 0) {
          // 选最大数值 serial（最新一条）。
          const newest = newSerials.slice().sort((a, b) => {
            const x = BigInt(b.split('-')[1] || '0');
            const y = BigInt(a.split('-')[1] || '0');
            return x < y ? -1 : (x > y ? 1 : 0);
          })[0];
          // 任务已受理（已扣费），但 MJ 出图需 1-2 分钟；serial 卡片的「下载」按钮
          // 只在出图完成后才出现 —— 它是比缩略图渲染更可靠的完成信号。
          // 轮询等待「下载」span 或失败文案，超时仍返回供下载阶段兜底。
          const waitStart = Date.now();
          const finishWait = Math.max(60000, timeout - (Date.now() - startTime)); // 用剩余预算等 MJ 出完图（本机实测排队约 11 分钟），总等待不超过 timeout
          while (Date.now() - waitStart < finishWait) {
            await this.page.waitForTimeout(5000);
            const st = await this.page.evaluate((id) => {
              const el = document.getElementById(id);
              if (!el) return { done: false, failed: false };
              const hasDl = [...el.querySelectorAll('span')].some(s => (s.textContent || '').trim() === '下载');
              const text = el.innerText || '';
              const failure = text.match(/(?:绘图失败|生成失败|出图失败)[：:]?\s*([^\n]{0,240})/);
              const reason = failure ? failure[1].replace(/\s+/g, ' ').trim() : '';
              return { done: hasDl, failed: !!failure, message: reason ? '绘图失败：' + reason : '生成失败' };
            }, newest).catch(() => ({ done: false, failed: false }));
            if (st.failed) {
              console.log(`[MXAI] 生成失败（serial ${newest} 卡片含失败文案）`);
              return { success: false, status: 'page_reported_failed', message: st.message, recordId: newest };
            }
            if (st.done) {
              console.log(`[MXAI] 生成完成！serial=${newest} 已出现「下载」按钮（共等待 ${Math.round((Date.now() - startTime) / 1000)}s）`);
              return { success: true, message: '生成完成', recordId: newest };
            }
          }
          // 【2026-09-12】等满预算还没出「下载」按钮：
          //   卡片里仍是排队/出图中文案 -> 这是排队未完成（status=queued），必须带着 serial 上报，
          //   上层用免费的 dl-serial 补下载即可，绝不能当成失败重跑。
          const still = await this.page.evaluate((id) => {
            const el = document.getElementById(id);
            const t = el ? (el.innerText || '') : '';
            return { text: t.replace(/\s+/g, ' ').slice(0, 120), queued: /排队|排第\s*\d+\s*位|全力出图|生成中|正在生成|队列/.test(t) };
          }, newest).catch(() => ({ text: '', queued: false }));
          if (still.queued) {
            console.log(`[MXAI] serial ${newest} 仍在排队/出图中，返回 status=queued（可用 dl-serial 免费补下载）`);
            return { success: false, status: 'queued', message: `任务仍在排队/出图（已等待 ${Math.round((Date.now() - startTime) / 1000)}秒）: ${still.text}`, recordId: newest, retry_allowed: false, warn: 'queued' };
          }
          console.log(`[MXAI] 警告: serial ${newest} 长时间未出「下载」按钮，交由下载阶段重试`);
          return { success: true, message: '生成完成（任务完成信号未出现，下载阶段将重试）', recordId: newest, warn: 'finish_timeout' };
        }

        // 不能只凭 img src 变化判定本次任务完成。页面会懒加载历史图片，
        // 这会把旧图误报成“新增图”，随后下载最新卡片就会串图。
        // 必须拿到本次点击生成后新增的 serial；没有可信 serial 就进入人工核查。
        if (newSrcs.length >= requiredNew || (newSrcs.length > 0 && /绘制完成|生成成功|已生成|出图完成/.test(pageText))) {
          if (!unassociatedSeen) {
            console.log(`[MXAI] 检测到图片变化但暂未找到本次 serial，继续等待关联（新增图 ${newSrcs.length}，已等待 ${elapsed}s）`);
            unassociatedSeen = true;
          }
        }

        // 仍处于进行中
        const queueHit = pageText.match(/(当前排第\s*\d+\s*位|排队中|正在排队|队列中|正在全力出图|生成中|正在生成)/);
        if (queueHit) {
          queueSeen = true;
          queueText = queueHit[1];
          console.log(`[MXAI] 生成中/排队中（${queueText}）... 已等待 ${elapsed}s（新增图 ${newSrcs.length}）`);
        } else if (/等待/.test(pageText)) {
          console.log(`[MXAI] 生成中... 已等待 ${elapsed}s（新增图 ${newSrcs.length}）`);
        }
      } catch (e) {
        console.log(`[MXAI] 等待中检查异常: ${e.message}`);
      }
    }

    if (unassociatedSeen) {
      return {
        success: false,
        status: 'unassociated_result',
        retry_allowed: false,
        recordId: null,
        message: '平台页面出现图片变化，但没有找到本次任务对应的 serial，已停止抓图以防串图',
        warning: '请人工核查平台记录；系统不会自动重提或下载页面最新旧图',
      };
    }

    // 【2026-09-12】超时也要分性质：排队中 != 失败。
    if (queueSeen) {
      return { success: false, status: 'queued', retry_allowed: false, recordId: null, message: `任务仍在排队（${queueText}），已等待 ${timeout / 1000} 秒；禁止自动重跑，请稍后用免费补下载取回结果` };
    }
    return { success: false, status: 'timeout', recordId: null, message: `等待超时（${timeout / 1000}秒）` };
  }

  /**
   * 下载最新生成的图片
   * 逻辑：优先下载「与基线相比新增」的图片；无基线时下载当前页面全部图片的前 4 张。
   * @param {string} outputDir - 输出目录
   * @param {string} prefix - 文件名前缀（如 task_id）
   * @returns {string[]} - 下载的文件路径列表
   */
  /**
   * 按 URL 抓取页面上的图片（缩略图路径）。
   *
   * 注意：这是**兜底通道**，站点给的往往是缩略图；中文版实测该通道会拿到
   *       140KB 的 loading 占位 GIF。因此这里同样强制内容校验，
   *       不合格的文件会被删除并计入 this._lastRejected，绝不返回给上层。
   *
   * @param {string} outputDir - 输出目录
   * @param {string} prefix - 文件名前缀（如 task_id）
   * @param {string|null} recordId - 指定 serial，避免队列串图
   * @returns {string[]} - 通过校验的文件路径列表
   */
  async downloadLatestImages(outputDir, prefix = 'result', recordId = null) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const downloaded = [];
    this._lastRejected = [];
    let srcs = [];

    // 优先：指定 serial 记录容器内的图片；没有指定时才取 DOM 第一条。
    try {
      const record = recordId
        ? this.page.locator(`#${recordId}`)
        : this.page.locator('div[id*="serial-"]').first();
      if (await record.count()) {
        srcs = await record.locator('img').evaluateAll(imgs =>
          imgs.map(i => i.currentSrc || i.src || '').filter(s => s.startsWith('http'))
        );
      }
    } catch (e) { /* 忽略 */ }

    // 生成流程中已有基线：用「新增」的图片更可靠
    if (this._baselineSrcs && this._baselineSrcs.size) {
      const all = [...(await this._collectImageSrcs())];
      const newSrcs = all.filter(s => !this._baselineSrcs.has(s));
      if (newSrcs.length) srcs = newSrcs;
    }

    // 兜底：全部图片
    if (!srcs.length) {
      srcs = [...(await this._collectImageSrcs())];
    }

    // 最多下载前 4 张
    const targets = srcs.slice(0, 4);
    console.log(`[MXAI] 待下载图片: ${targets.length} 张`);

    for (let i = 0; i < targets.length; i++) {
      try {
        const src = targets[i];
        const ext = (src.split('?')[0].match(/\.(png|jpe?g|webp|gif)/i) || [])[1] || 'png';
        const filename = `${prefix}_${i + 1}.${ext}`;
        const filepath = path.join(outputDir, filename);

        const response = await this.page.request.get(src, {
          headers: {
            Referer: this.mxaiUrl,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          },
        });
        if (response.ok()) {
          const buffer = await response.body();
          fs.writeFileSync(filepath, buffer);
          const info = inspectFile(filepath);
          if (info.ok) {
            downloaded.push(filepath);
            console.log(`[MXAI] 已下载并校验通过: ${filename} (${buffer.length} bytes, ${describeImg(info)})`);
          } else {
            this._lastRejected.push({ file: filepath, verdict: info.verdict, reason: info.reason, bytes: info.bytes });
            console.log(`[MXAI] 已丢弃不合格文件: ${filename} (${buffer.length} bytes) -> ${info.verdict}: ${info.reason}`);
            try { fs.unlinkSync(filepath); } catch (e2) { /* 忽略 */ }
          }
        } else {
          console.log(`[MXAI] 下载失败 HTTP ${response.status()}: ${src.slice(0, 80)}`);
        }
      } catch (e) {
        console.log(`[MXAI] 第 ${i + 1} 张图片下载失败: ${e.message}`);
      }
    }

    return downloaded;
  }

  /**
   * 通过页面上的「下载」按钮下载图片（捕获浏览器原生下载事件）
   * 流程：清理弹窗 → 点开最新记录详情 → 在详情视图找下载按钮 → 点击 → 捕获 download 事件 → 保存
   * @param {string} outputDir - 输出目录
   * @param {string} prefix - 文件名前缀
   * @param {number} timeout - 等待下载事件超时(ms)
   * @returns {object} - { success, downloaded:[...], error? }
   */
  /**
   * 内容校验：只有通过校验的文件才算「拿到了图」。
   * 拦截对象：loading 占位 GIF、错误页 HTML/JSON、几十 KB 的缩略图。
   * @param {string[]} files
   * @returns {{good:string[], bad:object[]}}
   */
  _verifyDownloads(files) {
    const good = [];
    const bad = [];
    const minBytes = Number(process.env.MJ_MIN_BYTES || 0) || undefined;
    const minDim = Number(process.env.MJ_MIN_DIM || 0) || undefined;
    const opts = {};
    if (minBytes) opts.minBytes = minBytes;
    if (minDim) { opts.minW = minDim; opts.minH = minDim; }
    for (const f of files || []) {
      try {
        const info = inspectFile(f, opts);
        if (info.ok) {
          good.push(f);
          console.log(`[MXAI] 校验通过 ${path.basename(f)}: ${describeImg(info)}`);
        } else {
          bad.push({ file: f, verdict: info.verdict, reason: info.reason, bytes: info.bytes, w: info.w, h: info.h });
          console.log(`[MXAI] 校验不通过 ${path.basename(f)}: ${info.verdict} - ${info.reason}`);
        }
      } catch (e) {
        bad.push({ file: f, verdict: 'INSPECT_ERROR', reason: e.message });
        console.log(`[MXAI] 校验异常 ${path.basename(f)}: ${e.message}`);
      }
    }
    return { good, bad };
  }

  /**
   * 通过页面上的「下载」按钮下载图片（捕获浏览器原生下载事件）
   *
   * 断点：旧版只要拿到 1 个文件就 return success:true，哪怕那是 140KB 的
   *       loading-new.gif 或 1KB 的错误页 —— 上层据此认为出图成功。
   * 修法：每条路径拿到的文件都必须先过 _verifyDownloads；不合格不返回成功，
   *       继续往下一层兜底；全部路径都失败时返回 ok:false 并带上失败原因清单。
   *
   * 说明：站点「下载」按钮给的是整张四宫格单文件（实测 1856x2464 / 1792x2688），
   *       这是预期行为，校验只看格式/尺寸/体积，不按张数判断。
   *
   * @param {string} outputDir - 输出目录
   * @param {string} prefix - 文件名前缀
   * @param {number} timeout - 等待下载事件超时(ms)
   * @param {string|null} recordId - 指定 serial，避免队列串图
   * @returns {object} - { ok, success, downloaded, rejected, note?, error? }
   */
  async downloadLatestViaButton(outputDir, prefix = 'latest', timeout = 30000, recordId = null) {
    if (!this.page) return { ok: false, success: false, downloaded: [], rejected: [], error: '浏览器未启动' };
    if (this._submissionStarted && !recordId) {
      return {
        ok: false,
        success: false,
        downloaded: [],
        rejected: [],
        error: '本次任务没有可信 serial，拒绝选择页面最新记录以防串图',
      };
    }
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const downloaded = [];
    const rejected = [];

    trace('downloadLatestViaButton start recordId=' + recordId + ' timeout=' + timeout);
    const settle = (files, note) => {
      const v = this._verifyDownloads(files);
      rejected.push(...v.bad);
      if (v.good.length) {
        return { ok: true, success: true, downloaded: v.good, rejected, note };
      }
      return null;
    };

    try {
      // 1) 清弹窗，确保从列表页开始
      trace('step1 dismissPopups begin');
      await this._dismissPopups();
      trace('step1 dismissPopups done');
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(800);

      // 2) 定位最新一条生成记录（按 serial id 数值取最大，避免 DOM 顺序歧义）
      const newestId = recordId || await this.page.evaluate(() => {
        const divs = Array.from(document.querySelectorAll('div[id*="serial-"]'));
        if (!divs.length) return null;
        divs.sort((a, b) => {
          const x = BigInt(b.id.split('-')[1] || '0');
          const y = BigInt(a.id.split('-')[1] || '0');
          return x < y ? -1 : (x > y ? 1 : 0);
        });
        return divs[0].id;
      });
      if (!newestId) return { ok: false, success: false, downloaded: [], rejected, error: '页面无生成记录' };
      trace('step2 newestId=' + newestId);

      // ===== 首选（2026-09-12）：页面内 Blob 捕获 =====
      // 这是唯一能拿到高清原图的路径（缩略图 URL 只有 330x660，outputs 直链 403）。
      try {
        const cap = await this._fetchViaBlobCapture(newestId, outputDir, prefix, 30000);
        if (cap && cap.ok) {
          downloaded.push(cap.file);
          const okRes = settle(downloaded, '已捕获页面 Blob 高清原图（已校验）');
          if (okRes) return okRes;
          console.log('[MXAI] Blob 捕获产物未通过校验，继续兜底');
        } else {
          trace('blob-capture failed: ' + (cap && cap.error));
        }
      } catch (e) { trace('blob-capture path error: ' + e.message); }

      // ===== 次选：直接按 URL 取高清原图 =====
      // 必须在点「下载」之前做（点完页面会自毁）。
      // 实测点「下载」会让页面在约 2 秒后自我关闭：download 事件虽触发，saveAs 已来不及。
      // 所以先趁页面存活时，从卡片缩略图 URL 推导 outputs 原图地址，用 request.get 直接拉取。
      try {
        const derived = await this._fetchFullResByUrl(newestId, outputDir, prefix);
        if (derived && derived.ok) {
          downloaded.push(derived.file);
          const okRes = settle(downloaded, '已按 URL 直接获取高清原图（已校验）');
          if (okRes) return okRes;
          console.log('[MXAI] URL 直取产物未通过校验，继续走按钮路径');
        }
      } catch (e) { trace('url-fetch path error: ' + e.message); }

      // 若已用 MXAI_SKIP_DL_BUTTON=1 关闭按钮路径，且 URL 直取没拿到合格图，就到此为止，
      // 不要再去点那个会让页面自毁的按钮（避免把浏览器状态搞脏）。
      if (/^(1|true|yes)$/i.test(String(process.env.MXAI_SKIP_DL_BUTTON || ''))) {
        return { ok: false, success: false, downloaded: [], rejected, error: 'URL 直取未取得合格图片（已按开关跳过按钮路径）' };
      }


      const skipDlButton = /^(1|true|yes)$/i.test(String(process.env.MXAI_SKIP_DL_BUTTON || ''));
      if (skipDlButton) trace('mainpath SKIPPED by MXAI_SKIP_DL_BUTTON');
      // ===== 主路径：点 serial 卡片操作栏的「下载」span，捕获原生 download 事件 =====
      // 站点原生下载按钮（data-v-8712fdb0 ml-2），直接吐高清原图（MJ v8.2 实测 1792x2688 PNG / 7.7MB），
      // 且不依赖缩略图是否已渲染（即使 <img> 仍卡 loading-new.gif，真实图已存在服务端）。
      try {
        if (skipDlButton) throw new Error('__skip_dl_button__');
        // 「下载」span 只在 MJ 出图完成后才出现，先轮询等它（时长取调用方 timeout，至少 60 秒）
        let spanVisible = false;
        const dlSpanStart = Date.now();
        while (Date.now() - dlSpanStart < Math.max(60000, timeout)) {
          spanVisible = await this.page.evaluate((id) => {
            const el = document.getElementById(id);
            return !!el && [...el.querySelectorAll('span')].some(s => (s.textContent || '').trim() === '下载');
          }, newestId).catch(() => false);
          if (spanVisible) break;
          // 【2026-09-12 修复】原来这里扫的是 document.body 全页文本。
          // 列表里会残留历史失败卡片的旧文案，全页扫描必然误判，
          // 于是「已成功出图」被当成「生成失败」直接放弃下载 —— 实测就是这样丢掉成品的。
          // 与 waitForResult() 的既有约定保持一致：只看本次 serial 卡片自身的文案。
          const ownFailed = await this.page.evaluate((id) => {
            const el = document.getElementById(id);
            return !!el && /绘图失败|生成失败|出图失败/.test(el.innerText || '');
          }, newestId).catch(() => false);
          if (ownFailed) {
            console.log(`[MXAI] serial ${newestId} 卡片自身含失败文案，判定本次生成失败`);
            return { ok: false, success: false, downloaded: [], rejected, error: '生成失败（本次任务卡片含失败文案），无法下载' };
          }
          await this.page.waitForTimeout(5000);
        }
        if (!spanVisible) console.log('[MXAI] 等待「下载」按钮超时（3分钟），回退预览器');
        trace('step3 spanVisible=' + spanVisible + ' waited=' + (Date.now() - dlSpanStart) + 'ms');

        trace('mainpath: span count=' + (await this.page.locator(`#${newestId} span`).filter({ hasText: /^下载$/ }).count().catch(() => -1)));
        const dlSpan = this.page.locator(`#${newestId} span`).filter({ hasText: /^下载$/ }).first();
        if (await dlSpan.count()) {
          await dlSpan.scrollIntoViewIfNeeded().catch(() => {});
          await this.page.waitForTimeout(400);
          trace('mainpath: about to click 下载; pageClosed=' + this.page.isClosed());
          const clickRes = await Promise.all([
            this.page.waitForEvent('download', { timeout: Math.min(60000, Math.max(15000, timeout)) }).then((d) => { trace('DOWNLOAD EVENT fired: ' + d.suggestedFilename() + ' url=' + String(d.url()).slice(0, 160)); return d; }).catch((e) => { trace('download event failed: ' + e.message); return null; }),
            dlSpan.click({ timeout: 5000, force: true }).then(() => { trace('click ok'); }).catch((e) => { trace('click err: ' + e.message); }),
          ]);
          const dl = clickRes[0];
          trace('mainpath: after click, dl=' + (dl ? 'yes' : 'null') + ' pageClosed=' + this.page.isClosed());
          if (dl) {
            const suggested = dl.suggestedFilename() || '';
            const m = suggested.match(/\.(png|jpe?g|webp|gif)$/i);
            const ext = m ? m[1].toLowerCase() : 'png';
            const fp = path.join(outputDir, `${prefix}_1.${ext}`);
            await dl.saveAs(fp);
            downloaded.push(fp);
            console.log(`[MXAI] 下载按钮已落盘: ${fp} (${fs.statSync(fp).size} bytes)，开始校验`);
            const okRes = settle(downloaded, '已通过下载按钮获取高清原图（已校验）');
            if (okRes) return okRes;
            console.log('[MXAI] 下载按钮产物未通过校验，继续走灯箱兜底');
          } else {
            console.log('[MXAI] 主路径「下载」按钮未触发 download 事件，回退预览器');
          }
        } else {
          console.log('[MXAI] 未找到 serial 内「下载」span，回退预览器');
        }
      } catch (e) {
        if (e && e.message === '__skip_dl_button__') { trace('mainpath skipped'); }
        else console.log(`[MXAI] 主路径「下载」失败: ${e.message}，回退预览器`);
      }


      // ===== 兜底：灯箱（.el-image-viewer__img → outputs 高清） =====
      trace('step4 mainpath done, downloaded=' + downloaded.length + ' fallback to lightbox');
      const rendered = await this._waitSerialRendered(newestId, 180000);
      if (!rendered || !rendered.ok) console.log('[MXAI] 警告: 最新 serial 图像仍处加载中，将尝试直接打开灯箱');

      let opened = false;
      for (let attempt = 0; attempt < 4 && !opened; attempt++) {
        await this.page.locator(`#${newestId} .el-image`).first().click({ timeout: 5000 }).catch(() => {});
        await this.page.waitForTimeout(1200);
        opened = await this.page.waitForSelector('.el-image-viewer__img', { timeout: 5000 })
          .then(() => true).catch(() => false);
        if (!opened) {
          await this.page.locator('.el-image').first().click({ timeout: 5000 }).catch(() => {});
          await this.page.waitForTimeout(1200);
          opened = await this.page.waitForSelector('.el-image-viewer__img', { timeout: 5000 })
            .then(() => true).catch(() => false);
        }
        if (!opened) { await this.page.keyboard.press('Escape').catch(() => {}); await this.page.waitForTimeout(400); }
      }
      if (!opened) {
        const fb = await this._downloadFromDetailDom(this.page, outputDir, prefix);
        const okRes = settle(fb, '预览器未打开，已回退详情页（已校验）');
        if (okRes) return okRes;
        return { ok: false, success: false, downloaded: [], rejected, error: '预览器未能打开，且详情页兜底未拿到合格图片' };
      }

      await this.page.waitForFunction(() => {
        const v = document.querySelector('.el-image-viewer__img');
        const s = v ? (v.currentSrc || v.src || '') : '';
        return s.includes('outputs');
      }, { timeout: 10000 }).catch(() => {});

      const src = await this.page.evaluate(() => {
        const v = document.querySelector('.el-image-viewer__img');
        const s = v ? (v.currentSrc || v.src || '') : '';
        return s.includes('outputs') ? s : '';
      });
      if (src) {
        const buf = await this.page.request.get(src, {
          headers: { Referer: this.mxaiUrl }, timeout: 30000,
        }).catch(() => null);
        if (buf && buf.ok()) {
          const body = await buf.body();
          const fp = path.join(outputDir, `${prefix}_1.webp`);
          fs.writeFileSync(fp, body);
          downloaded.push(fp);
          console.log(`[MXAI] 灯箱 outputs 已落盘: ${fp} (${body.length} bytes)，开始校验`);
          const okRes = settle(downloaded, '已获取高清原图（灯箱 outputs，已校验）');
          if (okRes) return okRes;
          console.log('[MXAI] 灯箱产物未通过校验，继续兜底');
        }
      }

      if (!downloaded.length) {
        const vBtn = this.page.locator('.el-image-viewer__actions')
          .locator('i.el-icon-download, [title="下载"], button, span:has-text("下载")').first();
        if (await vBtn.count()) {
          const [dl] = await Promise.all([
            this.page.waitForEvent('download', { timeout: timeout / 2 }).catch(() => null),
            vBtn.click({ timeout: 5000, force: true }),
          ]).catch(() => [null]);
          if (dl) {
            let ext = 'png';
            const m = (dl.suggestedFilename() || '').match(/\.(png|jpe?g|webp|gif)$/i);
            if (m) ext = m[1].toLowerCase();
            const fp = path.join(outputDir, `${prefix}_1.${ext}`);
            await dl.saveAs(fp);
            downloaded.push(fp);
            console.log(`[MXAI] 预览器下载按钮已落盘: ${fp}，开始校验`);
            const okRes = settle(downloaded, '已获取高清原图（预览器下载按钮，已校验）');
            if (okRes) return okRes;
          }
        }
      }

      await this.page.keyboard.press('Escape').catch(() => {});

      const fb2 = await this._downloadFromDetailDom(this.page, outputDir, prefix);
      const okRes2 = settle(fb2, '已回退详情页（已校验）');
      if (okRes2) return okRes2;

      return {
        ok: false, success: false, downloaded: [], rejected,
        error: '所有下载路径均未取得合格图片（高清失败且缩略图兜底也未通过内容校验）',
      };
    } catch (e) {
      trace('downloadLatestViaButton CAUGHT: ' + e.message);
      return { ok: false, success: false, downloaded: [], rejected, error: e.message };
    }
  }

  /**
   * 兜底：从详情页 DOM 中抓取高清图片 URL 下载（不依赖按钮触发）
   */
  /**
   * 兜底：从详情页 DOM 中抓取高清图片 URL 下载（不依赖按钮触发）
   * 同样过内容校验：不合格文件删除并计入 _lastRejected。
   */
  /**
   * 按 URL 直取高清原图（不依赖页面存活）。
   * 站点缩略图形如 .../draw/thumbnail/<uid>/<ymd>/<serial>_<hash>.png，
   * 高清原图同路径把 thumbnail 换成 outputs。逐个候选拉回来过内容校验。
   */
  /**
   * 通过页面内 Blob 捕获取高清原图（2026-09-12 新增，缺陷 E 的真正修复）。
   * 实测：站点「下载」是前端把高清原图做成 Blob 再触发下载；点完约 1.7 秒页面会自我关闭，
   * download 事件虽触发，但 saveAs 已来不及（临时文件随上下文销毁），所以一直「补下载失败」。
   * 这里改为在页面内截获 Blob 本体（含 window.close 拦截，防止页面自毁），直接读回字节。
   */
  async _fetchViaBlobCapture(serialId, outputDir, prefix, waitMs = 30000) {
    if (!this.page) return { ok: false, error: '浏览器未启动' };

    // 接收槽：页面把字节推过来时直接落盘（缺陷 G）。
    this._blobSink = { outputDir, prefix, files: [] };
    const sniffed = [];
    const serialNum = String(serialId || '').replace(/^serial-/, '');

    const hooked = await this.page.evaluate(() => {
      try {
        if (!window.__mjBlobHook) {
          window.__mjBlobHook = true;
          window.__mjBlobs = [];
          // 关键：createObjectURL 一被调用就立刻把字节推给 Node。
          // 站点「下载」= 前端把高清原图做成 Blob 再触发下载，随后约 1.8 秒页面自毁；
          // 只有抢在自毁前让字节离开渲染进程，7.6MB 的成品才不会丢。
          const pushBlob = (blob) => {
            try { window.__mjBlobs.push({ blob: blob, size: blob && blob.size, type: blob && blob.type }); } catch (e) { /* 忽略 */ }
            try {
              if (blob && blob.size >= 100000 && /^image\//.test(String(blob.type || ''))) {
                blob.arrayBuffer().then((buf) => {
                  try {
                    const bytes = new Uint8Array(buf);
                    let bin = '';
                    const chunk = 0x8000;
                    for (let i = 0; i < bytes.length; i += chunk) {
                      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                    }
                    const b64 = btoa(bin);
                    if (typeof window.__mjSaveBase64 === 'function') {
                      window.__mjSaveBase64({ b64: b64, type: blob.type || '', size: blob.size }).catch(() => {});
                    }
                  } catch (e) { /* 忽略 */ }
                }).catch(() => {});
              }
            } catch (e) { /* 忽略 */ }
          };
          const origCreate = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            const u = origCreate.call(URL, blob);
            pushBlob(blob);
            return u;
          };
          try { window.__mjOrigClose = window.close; window.close = function () { return undefined; }; } catch (e) { /* 忽略 */ }
        }
        return true;
      } catch (e) { return false; }
    }).catch(() => false);
    trace('blob-capture hook installed=' + hooked);

    // 【2026-09-12 缺陷 I 取证】点击「下载」后站点到底发了哪些请求。
    // 之前只记了 image/* 的响应体大小，看不出「第二次点下载一个请求都没发」这件事，
    // 这里把所有请求都记下来（含非图片），用于判定站点是否对同一 serial 幂等。
    const netLog = this._netLog = [];
    // 【2026-09-12 缺陷 G/I 的真正修复 · 快车道】
    // 取证结论：点「下载」后站点确实会请求带签名的原图直链
    //   https://cdn.qihuiai.com/attachment/draw/outputs/<uid>/<ymd>/<serial>_0.webp?auth_key=...
    // 但页面会在约 4 秒后自毁，把这个请求一起掐死 —— 所以「抓 Blob」总是来不及。
    // 正确做法：一在请求里看到这条直链，立刻用浏览器上下文自己的 request 独立去拉，
    // 它不依赖页面存活，页面关掉也照样能下完。实测该直链可独立返回 200 / 887KB 原图。
    const fastLane = [];
    const onReq = (req) => {
      try {
        const u = String(req.url() || '');
        if (/^data:|^blob:/.test(u)) return;
        netLog.push({ t: Date.now(), m: req.method(), u: u.slice(0, 200), r: req.resourceType() });
        if (!/\/draw\/outputs\//.test(u) || !/auth_key=/.test(u)) return;
        if (serialNum && !u.includes(serialNum)) {
          trace('fastlane: 忽略非本次 serial 的原图直链');
          return;
        }
        if (fastLane.some((x) => x.url === u)) return;
        const entry = { url: u, size: 0, file: null, done: false };
        fastLane.push(entry);
        trace('fastlane: 捕获原图直链，立即独立下载 ' + u.slice(0, 150));
        const reqCtx = (this.context && this.context.request) || (this.page && this.page.request);
        if (!reqCtx) { trace('fastlane: 无可用的 request 上下文'); return; }
        reqCtx.get(u, { headers: { Referer: this.mxaiUrl }, timeout: 60000 })
          .then(async (r) => {
            if (!r.ok()) { trace('fastlane: HTTP ' + r.status()); return; }
            const body = await r.body();
            const ct = String((r.headers() || {})['content-type'] || '');
            const ext = /jpe?g/.test(ct) ? 'jpg' : (/webp/.test(ct) ? 'webp' : 'png');
            // 文件名带上 serial：prefix 由任务 id 决定，重试时会变，serial 不会变。
            const fp = path.join(outputDir, prefix + (serialNum ? '_' + serialNum : '') + '_hi.' + ext);
            fs.writeFileSync(fp, body);
            entry.size = body.length; entry.file = fp; entry.done = true;
            sniffed.push({ file: fp, size: body.length, type: ct });
            trace('fastlane: 落盘 ' + fp + ' ' + body.length + 'B');
          })
          .catch((e) => trace('fastlane err: ' + e.message));
      } catch (e) { /* 忽略 */ }
    };
    try { this.page.on('request', onReq); } catch (e) { /* 忽略 */ }

    // 安全网：站点若改用 fetch 拉原图，这里能直接截到大图响应体。
    const onResp = (resp) => {
      try {
        const respUrl = String(resp.url() || '');
        if (serialNum && !respUrl.includes(serialNum) && /\/draw\/outputs\//.test(respUrl)) return;
        const ct = String((resp.headers() || {})['content-type'] || '');
        if (!/image\//.test(ct)) return;
        const len = Number((resp.headers() || {})['content-length'] || 0);
        if (len && len < 200000) return;
        resp.body().then((body) => {
          try {
            if (body && body.length >= 200000) {
              const ext = /jpe?g/.test(ct) ? 'jpg' : (/webp/.test(ct) ? 'webp' : 'png');
              const fp = path.join(outputDir, prefix + '_net.' + ext);
              fs.writeFileSync(fp, body);
              sniffed.push({ file: fp, size: body.length, type: ct });
              trace('net-sniff wrote ' + fp + ' ' + body.length + 'B');
            }
          } catch (e) { /* 忽略 */ }
        }).catch(() => {});
      } catch (e) { /* 忽略 */ }
    };
    try { this.page.on('response', onResp); } catch (e) { /* 忽略 */ }

    try {
      const dlSpan = this.page.locator('#' + serialId + ' span').filter({ hasText: /^下载$/ }).first();
      const cnt = await dlSpan.count().catch(() => 0);
      if (!cnt) return { ok: false, error: '未找到下载按钮' };
      await dlSpan.scrollIntoViewIfNeeded().catch(() => {});
      trace('blob-capture clicking 下载');
      // 【2026-09-12 缺陷 I】三种点击策略依次尝试，排除「点击落到错误元素」这一可能。
      // 若三种都点过仍无任何网络请求，就能确证是站点侧幂等，而不是我们点歪了。
      const reqBefore = (this._netLog || []).length;
      await dlSpan.click({ timeout: 5000, force: true }).catch((e) => trace('blob-capture click#1 err: ' + e.message));
      await lockSleepMs(1200);
      if ((this._netLog || []).length - reqBefore <= 1) {
        trace('blob-capture click#1 未产生新请求，尝试坐标点击');
        const box = await dlSpan.boundingBox().catch(() => null);
        if (box) {
          await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch((e) => trace('blob-capture click#2 err: ' + e.message));
          await lockSleepMs(1200);
        }
      }
      if ((this._netLog || []).length - reqBefore <= 1) {
        trace('blob-capture click#2 仍未产生新请求，尝试派发 DOM click 事件');
        await dlSpan.evaluate((el) => {
          try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e) { /* 忽略 */ }
        }).catch((e) => trace('blob-capture click#3 err: ' + e.message));
        await lockSleepMs(1200);
      }
      const reqAfter = (this._netLog || []).length;
      trace('blob-capture click 阶段结束：新增请求 ' + (reqAfter - reqBefore) + ' 条');
      if (reqAfter - reqBefore > 0) {
        trace('blob-capture 点击后请求样本: ' + JSON.stringify(this._netLog.slice(reqBefore, reqBefore + 12).map((x) => x.m + ' ' + x.u)));
      }

      const startedAt = Date.now();
      let pageGoneAt = 0;
      let firstCaptureAt = 0;
      while (Date.now() - startedAt < waitMs) {
        const got = this._blobSink.files.length + sniffed.length;
        if (got) {
          if (!firstCaptureAt) firstCaptureAt = Date.now();
          // 站点是先发网络请求拿图、再建 Blob 触发下载。网络嗅探往往先命中，
          // 但站点自带的无损 PNG 原图（约 7.6MB）通常紧随其后。
          // 留 8 秒追赶窗口，让两条路都能落地，最后取最大的那个（无损优先）。
          if (Date.now() - firstCaptureAt > 8000) break;
        }
        const gone = !this.page || this.page.isClosed();
        if (gone && !pageGoneAt) pageGoneAt = Date.now();
        // 页面自毁后，快车道可能还在拉图，给它 20 秒收尾时间（直链约 887KB，实测 2 秒内完成）。
        if (pageGoneAt) {
          const pending = fastLane.filter((x) => !x.done);
          const grace = pending.length ? 20000 : 3000;
          if (Date.now() - pageGoneAt > grace) break;
        }
        await lockSleepMs(250);
      }
    } finally {
      try { this.page.removeListener('response', onResp); } catch (e) { /* 忽略 */ }
      try { this.page.removeListener('request', onReq); } catch (e) { /* 忽略 */ }
      try {
        trace('blob-capture 点击后累计请求 ' + (this._netLog || []).length + ' 条；最近 10 条: '
          + JSON.stringify((this._netLog || []).slice(-10).map((x) => x.m + ' ' + x.u)));
      } catch (e) { /* 忽略 */ }
    }

    // 快车道收尾：页面已死但直链下载还在飞，等它落地再判定。
    for (let i = 0; i < 40 && fastLane.some((x) => !x.done); i++) await lockSleepMs(500);
    const sink = this._blobSink || { files: [] };
    const all = sink.files.concat(sniffed);
    this._blobSink = null;
    if (!all.length) {
      trace('blob-capture: no bytes captured within ' + waitMs + 'ms');
      return { ok: false, error: '未捕获到 Blob 字节（页面自毁前未送达）' };
    }
    const best = all.reduce((a, b) => (b.size > a.size ? b : a));
    trace('blob-capture captured=' + JSON.stringify(all.map((x) => ({ f: x.file, size: x.size }))) + ' best=' + best.file);
    return { ok: true, file: best.file };
  }

  async _fetchFullResByUrl(serialId, outputDir, prefix) {
    if (!this.page) return { ok: false, error: '浏览器未启动' };
    const cands = await this.page.evaluate((id) => {
      const el = document.getElementById(id);
      const out = [];
      if (!el) return out;
      const push = (s) => { if (s && s.startsWith('http')) out.push(s); };
      [...el.querySelectorAll('img')].forEach((i) => push(i.currentSrc || i.src || ''));
      [...el.querySelectorAll('*')].forEach((n) => {
        for (const a of (n.attributes || [])) {
          if (/^(src|href|data-src|data-original|data-url|style)$/.test(a.name)) push(a.value || '');
        }
      });
      return [...new Set(out)];
    }, serialId).catch(() => []);
    trace('url-fetch candidates=' + cands.length);

    const urls = [];
    for (const c of cands) {
      const clean = String(c).replace(/^url\(['"]?/, '').replace(/['"]?\)$/, '').split(' ')[0];
      if (!/^https?:/.test(clean)) continue;
      if (!/qihuiai\.com/.test(clean)) continue;
      urls.push(clean);
      const noQuery = clean.split('?')[0];
      const variants = [
        noQuery.replace('/thumbnail/', '/outputs/'),
        noQuery.replace('/thumbnail/', '/output/'),
        noQuery.replace('/thumbnail/', '/image/'),
        noQuery.replace('/thumbnail/', '/origin/'),
        noQuery.replace('/thumbnail/', '/'),
        noQuery,
      ];
      for (const v of variants) if (/^https?:/.test(v)) urls.push(v);
    }
    const uniq = [...new Set(urls)].filter((u) => !/prasie|toolbar|\/images\//.test(u));
    trace('url-fetch trying ' + uniq.length + ' urls');

    for (const u of uniq.slice(0, 14)) {
      try {
        const resp = await this.page.request.get(u, { headers: { Referer: this.mxaiUrl }, timeout: 30000 }).catch(() => null);
        if (!resp || !resp.ok()) { trace('url-fetch skip(HTTP ' + (resp && resp.status()) + '): ' + u.slice(0, 110)); continue; }
        const body = await resp.body();
        const ext = (u.split('?')[0].match(/\.(png|jpe?g|webp|gif)/i) || [])[1] || 'png';
        const fp = path.join(outputDir, prefix + '_url.' + ext.toLowerCase());
        fs.writeFileSync(fp, body);
        const info = inspectFile(fp);
        trace('url-fetch ' + body.length + 'B -> ' + info.verdict + ' (' + (info.w || 0) + 'x' + (info.h || 0) + ') ' + u.slice(0, 90));
        if (info.ok) return { ok: true, file: fp, bytes: body.length };
        try { fs.unlinkSync(fp); } catch (_) { /* 忽略 */ }
      } catch (e) { trace('url-fetch err: ' + e.message); }
    }
    return { ok: false, error: '未找到合格高清 URL' };
  }

  async _downloadFromDetailDom(targetPage, outputDir, prefix) {
    const downloaded = [];
    try {
      const candidates = await targetPage.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const out = [];
        for (const i of imgs) {
          const s = i.currentSrc || i.src || '';
          if (!s.startsWith('http')) continue;
          if (s.includes('icon') || s.includes('/images/')) continue;
          if (!s.includes('qihuiai.com')) continue;
          if (s.includes('/thumbnail/')) continue;
          out.push({ s, w: i.naturalWidth || 0, h: i.naturalHeight || 0 });
        }
        out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
        return out.slice(0, 4).map(x => x.s);
      });
      if (!candidates.length) {
        const all = await targetPage.evaluate(() => Array.from(document.querySelectorAll('img'))
          .map(i => i.currentSrc || i.src || '')
          .filter(s => s.startsWith('http') && s.includes('qihuiai.com') && !s.includes('icon') && !s.includes('/images/')));
        candidates.push(...all.slice(0, 4));
      }
      for (let i = 0; i < candidates.length; i++) {
        try {
          const ext = (candidates[i].split('?')[0].match(/\.(png|jpe?g|webp|gif)/i) || [])[1] || 'png';
          const buf = await targetPage.request.get(candidates[i], { headers: { Referer: this.mxaiUrl } });
          if (buf.ok()) {
            const fp = path.join(outputDir, `${prefix}_${i + 1}.${ext}`);
            fs.writeFileSync(fp, await buf.body());
            const info = inspectFile(fp);
            if (info.ok) {
              downloaded.push(fp);
            } else {
              this._lastRejected = this._lastRejected || [];
              this._lastRejected.push({ file: fp, verdict: info.verdict, reason: info.reason, bytes: info.bytes });
              console.log(`[MXAI] 详情页兜底丢弃不合格文件: ${path.basename(fp)} -> ${info.verdict}`);
              try { fs.unlinkSync(fp); } catch (e2) { /* 忽略 */ }
            }
          }
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
    return downloaded;
  }

  /**
   * 安全的诊断（不抛错）
   */
  async _safeDiagnose(page) {
    try { return await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], span, div')).map(b => ({
        t: (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 24),
        c: ((b.className && b.className.toString ? b.className.toString() : '') || '').slice(0, 50),
      })).filter(x => x.t);
      return { url: location.href, buttons: btns.slice(0, 40) };
    }); } catch (e) { return { error: e.message }; }
  }

  /**
   * 诊断：输出当前页面 DOM 结构关键信息（记录容器 id、图片数量与 src、页面文本片段）
   */
  async diagnose() {
    if (!this.page) return { error: '浏览器未启动' };
    try {
      const info = await this.page.evaluate(() => {
        const serials = Array.from(document.querySelectorAll('div[id*="serial-"]')).map(d => d.id);
        const imgs = Array.from(document.querySelectorAll('img')).map(i => i.currentSrc || i.src || '').filter(Boolean);
        // 弹窗/遮罩/对话框：找常见 class 关键词 或 role=dialog
        const overlayKeywords = ['modal', 'dialog', 'popup', 'pop-up', 'overlay', 'mask', 'ad-', '-ad', 'advert', 'coupon', 'banner', 'notice', 'tip', 'guide', 'welcome'];
        const overlayCandidates = [];
        document.querySelectorAll('*').forEach(el => {
          const cls = (el.className && el.className.toString ? el.className.toString() : '') || '';
          const id = el.id || '';
          const role = el.getAttribute && el.getAttribute('role');
          const hit = overlayKeywords.some(k => cls.toLowerCase().includes(k) || id.toLowerCase().includes(k) || (role && role.toLowerCase().includes(k)));
          if (hit) {
            const rect = el.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
            if (visible) {
              // 直接子元素里的关闭/取消按钮
              const closeSel = el.querySelector('button, a, [role="button"], span, div');
              const btnTexts = Array.from(el.querySelectorAll('button, a, [role="button"]')).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 12);
              overlayCandidates.push({
                tag: el.tagName,
                id,
                cls: cls.slice(0, 80),
                role,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                btnTexts,
              });
            }
          }
        });
        // 页面上所有按钮（含 a[role=button]）
        const allButtons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]')).map(b => {
          const rect = b.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(b).display !== 'none';
          return {
            text: (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 30),
            cls: ((b.className && b.className.toString ? b.className.toString() : '') || '').slice(0, 60),
            visible,
          };
        }).filter(b => b.text).slice(0, 40);
        return {
          serialIds: serials.slice(0, 15),
          serialCount: serials.length,
          imgCount: imgs.length,
          imgSrcs: imgs.slice(0, 15),
          overlayCandidates: overlayCandidates.slice(0, 20),
          allButtons,
          bodySample: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 600),
        };
      }).catch(e => ({ error: e.message }));
      return { url: this.page.url(), ...info };
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * 点开最新一条生成记录（打开详情/大图预览），等待加载后返回诊断信息
   * 用于在 mxai 详情视图中定位高清原图 URL。
   */
  async openLatestDetail() {
    if (!this.page) return { error: '浏览器未启动' };
    try {
      const record = this.page.locator('div[id*="serial-"]').first();
      if (!(await record.count())) return { error: '页面无生成记录' };
      const img = record.locator('img').first();
      await img.click({ timeout: 5000 }).catch(async () => {
        await record.click({ timeout: 5000 });
      });
      // 等待详情/预览加载（可能弹新窗口，用 context 事件捕获）
      const popupPromise = this.context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
      await this.page.waitForTimeout(3000);
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        await popup.waitForTimeout(2500);
        this.page = popup;
      }
      return await this.diagnose();
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * 只下载当前页面已有图片（不触发新生成）
   */
  async downloadLatest(outputDir, prefix = 'latest') {
    return this.downloadLatestImages(outputDir, prefix);
  }

  /**
   * 完整的生成流程
   * @param {string} prompt - 提示词（可包含参数，如 --v 8.2 --ar 9:16）
   * @param {object} options - { version, aspect, mode, stylize, chaos, outputDir, filePrefix, timeout }
   * @returns {object} - { success, message, images, recordId }
   */
  /**
   * 记一笔回执到 receipts/mxai-tasks.jsonl（成功、失败都写，禁止无账可查）
   * 字段定义见 receipts/README.md
   */
  _writeReceipt(entry) {
    try {
      const dir = process.env.MJ_RECEIPTS_DIR || path.join(__dirname, '..', 'receipts');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, 'mxai-tasks.jsonl');
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      fs.appendFileSync(fp, line + '\n', 'utf8');
      console.log(`[MXAI] 回执已记账: ${fp}`);
    } catch (e) {
      console.log(`[MXAI] 回执写入失败（不影响主流程）: ${e.message}`);
    }
  }

  /**
   * 完整的生成流程
   *
   * 断点：旧版在第 8 步「没拿到图」时回退 downloadLatestImages()（抓页面缩略图、
   *       不做任何内容校验），仍然返回 success:true —— 用户看到“成功”，
   *       拿到的却是 140KB 的 loading 占位图。
   * 修法：拿到文件必须过 _verifyDownloads；不合格即返回
   *       success:false / status:'download_failed'，并带上被拒文件的原因清单。
   *       同时每次生成结束都写一笔回执，账目可查。
   *
   * 保留：_submissionStarted 防重复扣费设计 —— 一旦点过「立即生成」，
   *       后续任何超时都不自动重试，由上层人工确认。
   *
   * @param {string} prompt - 提示词（可含参数，如 --v 8.2 --ar 9:16）
   * @param {object} options - { version, aspect, mode, outputDir, filePrefix, timeout, taskId }
   * @returns {object} - { success, status, message, images, recordId, rejected? }
   */
  async generate(prompt, options = {}) {
    const {
      version = 'v8.2',
      aspect = '9:16',
      mode = 'normal',
      outputDir = process.env.MJ_OUTPUT_DIR || path.join(__dirname, '..', 'output'),
      filePrefix = 'mxai_result',
      outputName = null,
      timeout = 240000,
      taskId = null,
      // 比例档位未切换成功时是否允许带着错误比例继续出图。
      // 默认 false：宁可中止（不点生成、不扣费），也不产出"看起来成功"的错误比例图。
      allowAspectDegrade = false,
    } = options;

    this._submissionStarted = false;
    this._submissionConfirmed = false;
    const outputStem = safeOutputStem(outputName || filePrefix) + "_" + crypto.createHash('sha256').update(String(taskId || filePrefix)).digest('hex').slice(0, 12);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const promptHash = crypto.createHash('sha256').update(String(prompt)).digest('hex').slice(0, 16);
    const adapter = this;
    const baseReceipt = {
      task_id: taskId,
      effective_prompt: String(prompt),
      requested_version: version,
      parameter_verification: 'transport_only',
      prompt_hash: promptHash,
      requested_aspect: aspect,
      output_name: outputStem,
    };

    const finish = (res) => {
      const submitted = typeof res.submitted === "boolean" ? res.submitted : (adapter._submissionConfirmed ? true : (adapter._submissionStarted ? null : false));
      res.submitted = submitted;
      reportPhase(res.success ? "completed" : "result_pending", submitted);
      const files = (res.images || []).map((f) => {
        try {
          const i = inspectFile(f);
          return { file: f, bytes: i.bytes, w: i.w, h: i.h, format: i.format, sha256: i.sha256 };
        } catch (e) { return { file: f, error: e.message }; }
      });
      adapter._writeReceipt({
        ...baseReceipt,
        serial: res.recordId || null,
        version_applied: adapter._lastVersion?.applied || null,
        version_verified: adapter._lastVersion?.verified === true,
        submitted,
        billed: typeof res.billed === "boolean" ? res.billed : null,
        // 规格对账：requested（调用方要的）与 applied（页面真实点中的）分开记，防止再次静默降级。
        aspect_requested: aspect,
        aspect_note: (adapter._lastAspect && adapter._lastAspect.note) || null,
        aspect: (adapter._lastAspect && adapter._lastAspect.applied) || null,
        files,
        rejected: res.rejected || [],
        status: res.status || (res.success ? 'ok' : 'failed'),
        seconds: Math.round((Date.now() - t0) / 1000),
        message: res.message || res.error || null,
        started_at: startedAt,
      });
      return res;
    };

    try {
      // 1. 确保浏览器已启动
      if (!this.context) {
        await this.launch();
      }
      await this.navigate();

      // 2. 检查登录
      await this.ensureLoggedIn();

      // 3. 关闭弹窗
      await this._dismissPopups();

      // 4. 输入提示词（先剥离提示词里的 --ar / --aspect：比例只认页面档位，避免双来源冲突）
      const arStrip = stripAspectParams(prompt);
      if (arStrip.removed.length) {
        console.log('[MXAI] 已从提示词剥离尺寸参数 ' + arStrip.removed.join(' ')
          + '；出图比例一律由页面「生成尺寸」档位决定');
      }
      baseReceipt.prompt_aspect_stripped = arStrip.removed;
      await this.fillPrompt(arStrip.prompt);

      // 5. 选择参数（页面「生成尺寸」档位是出图比例的唯一权威来源）
      //    提示词里的 --ar / --aspect 已在第 4 步剥离，因此不存在第二个比例来源；
      //    档位没切成功就等于比例无法保证，必须显式失败/降级，绝不静默按默认比例出图。
      await this.selectVersion(version);
      await this.selectMode(mode);
      const aspectRes = await this.selectAspect(aspect);
      baseReceipt.aspect_requested = aspectRes.requested;
      baseReceipt.aspect_applied = aspectRes.applied;
      baseReceipt.aspect_ok = aspectRes.ok;
      if (!aspectRes.ok) {
        if (allowAspectDegrade) {
          console.log(`[MXAI] 警告: 页面档位未切换成功（${aspectRes.note}）；allowAspectDegrade=true，按页面当前档位继续，回执已标记 aspect_ok=false`);
        } else {
          // 未授权降级：直接终止，避免"看起来成功、其实是错误比例"的假产出。
          const err = new Error(`比例档位未切换成功（${aspectRes.note}）；已中止，未点击生成、未产生费用。`);
          err.code = 'ASPECT_NOT_APPLIED';
          err.aspect = aspectRes;
          throw err;
        }
      }

      // 6. 点击生成前记录基线
      this._baselineSrcs = await this._collectImageSrcs();
      this._baselineSerials = await this._collectSerialIds();
      this._submissionStarted = false;
      // Persist ambiguous click intent before contacting the platform.
      this._submissionStarted = true;
      reportPhase("submitting", null);
      await this.clickGenerate();
      this._submissionConfirmed = true;
      reportPhase("platform_generating", true);
      // 点击成功后即视为“可能已扣费/已入队”；后续超时不得自动重试。
      this._submissionStarted = true;

      // 7. 等待结果
      const result = await this.waitForResult(timeout);
      if (!result.success && this._submissionStarted) {
        // 【2026-09-12】排队中（status=queued）是明确的、可自助恢复的状态：任务已受理并扣费，
        // 稍后用 dl-serial 就能免费取回成品。不能被笼统的 receipt_pending 覆盖，
        // 否则上层分不清该「等」还是该「查」。
        if (result.status === 'queued') {
          return finish({
            ...result,
            status: 'queued',
            retry_allowed: false,
            warning: '任务仍在排队/出图中；请稍后用免费补下载取回（dl-serial ' + (result.recordId || '无 serial') + '），禁止重跑',
          });
        }
        // 【2026-09-14】平台已判定本次生成失败（卡片含失败文案）是**终态**，
        // 和「回执未知」不是一回事：这类任务站点侧不会再出图，本地也不会有成品，
        // 补下载跑一百遍也是空手而归。必须单独上报，否则看护脚本会把它当候选，
        // 白开一次可见浏览器、白等十几分钟。
        if (result.status === 'page_reported_failed') {
          return finish({
            ...result,
            status: 'page_reported_failed',
            retry_allowed: false,
            warning: '平台已判定本次生成失败（未出图）。不会自动重试；如需重出请先人工确认（会重新扣积分）',
          });
        }
        return finish({ ...result, status: result.status || 'receipt_pending', retry_allowed: false, warning: result.warning || '已点击生成但尚未拿到确定回执，禁止自动重试' });
      }
      if (!result.success) {
        return finish({ ...result, status: result.status || 'failed' });
      }

      // 没有本次 serial 就不能选择“最新卡片”。最新卡片可能属于历史任务，
      // 这是本次真实测试抓到错误波形图的根因。
      if (!result.recordId) {
        return finish({
          ...result,
          success: false,
          status: 'unassociated_result',
          images: [],
          retry_allowed: false,
          message: '生成信号未关联到本次任务 serial，已停止下载以防串图',
          warning: '请人工核查平台记录；不会自动重提或抓取最新旧图',
        });
      }

      // 8. 通过页面「下载」按钮获取高清原图，并强制内容校验
      reportPhase("downloading", true);
      const dl = await this.downloadLatestViaButton(outputDir, outputStem, 120000, result.recordId)
        .catch((e) => ({ ok: false, success: false, downloaded: [], rejected: [], error: e.message }));

      if (dl.ok && dl.downloaded && dl.downloaded.length) {
        return finish({
          ...result,
          status: 'ok',
          images: dl.downloaded,
          rejected: dl.rejected || [],
          aspect: aspectRes,
          message: dl.note || '生成完成，已获取并校验通过高清原图',
        });
      }

      // 校验未通过 —— 明确失败，不再静默降级报成功
      return finish({
        ...result,
        success: false,
        status: 'download_failed',
        images: [],
        rejected: dl.rejected || [],
        aspect: aspectRes,
        retry_allowed: false,
        message: dl.error || '生成已完成，但未取得通过内容校验的图片',
        warning: '图片可能已生成在站内，请人工在浏览器中查看并手动下载；不要盲目重跑以免重复扣积分',
      });
    } catch (e) {
      console.error(`[MXAI] 生成流程异常: ${e.message}`);
      // 保留可判别的失败码（如 ASPECT_NOT_APPLIED = 未点击生成、未扣费），
      // 避免上层把它和"已扣费的失败"混为一谈而盲目重跑。
      const status = e.code ? String(e.code).toLowerCase() : 'exception';
      const extra = {};
      if (e.code === 'ASPECT_NOT_APPLIED') {
        extra.submitted = false;
        extra.billed = false;
        extra.aspect = e.aspect || null;
      }
      return finish({ success: false, status, message: e.message, images: [], recordId: null, ...extra });
    }
  }
}

module.exports = MxaiAdapter;

// 静态挂载：修正上一版「先挂属性、再整体替换 module.exports」导致属性丢失的缺陷。
// 用法：const { stripAspectParams } = require('./mxai_adapter');
//       require('./mxai_adapter').stripAspectParams('正文 --ar 9:16')
module.exports.stripAspectParams = stripAspectParams;
MxaiAdapter.stripAspectParams = stripAspectParams;
module.exports.safeOutputStem = safeOutputStem;
MxaiAdapter.safeOutputStem = safeOutputStem;

// 命令行测试入口
if (require.main === module) {
  const adapter = new MxaiAdapter({ headless: false });
  
  (async () => {
    try {
      await adapter.launch();
      await adapter.navigate();
      
      const loggedIn = await adapter.isLoggedIn();
      console.log(`已登录: ${loggedIn}`);
      
      if (loggedIn) {
        // 测试：输入一个简单提示词但不点击生成
        await adapter.fillPrompt('测试提示词，一只可爱的猫咪 --v 8.2 --ar 9:16');
        await adapter.selectVersion('v8.2');
        await adapter.selectAspect('9:16');
        console.log('测试完成，未点击生成按钮');
      }
      
      // 保持浏览器打开供用户操作
      console.log('浏览器保持打开，按 Ctrl+C 退出');
    } catch (e) {
      console.error('测试失败:', e);
      await adapter.close();
    }
  })();
}
