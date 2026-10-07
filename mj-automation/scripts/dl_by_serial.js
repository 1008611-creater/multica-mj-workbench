/**
 * 按 serial id 补下载高清原图（三路兜底 + 强制内容校验）—— 改造副本
 *
 * 来源: E:\codex\niannianai\zhuanhuiyuangong\ai-rpa-console\dl_by_serial.js
 * 改造:
 *   1. 引入 verify_result.js 做内容校验：loading 占位图 / 错误页 / 缩略图一律不算成功
 *   2. 归档目录改为可配置 MJ_ARCHIVE_DIR（原文写死的相对路径在当前目录结构下已失效）
 *   3. 输出单行 JSON 供上层解析，同时保留人读日志
 *
 * 三路兜底：
 *   A. 点 serial 内「下载」span 捕获原生下载 / popup 新标签页
 *   B. 点击落点被遮挡时先清遮挡并校验 elementFromPoint
 *   C. 灯箱兜底：点 .el-image 开预览器 → 抓 outputs 高清 URL → 带签名抓取
 *
 * 用法:
 *   node dl_by_serial.js <serial数字id> <输出基名> [期望最小宽] [期望最小高]
 *
 * 退出码：0 成功 / 1 参数错 / 2 页面找不到该 serial / 4 三路全失败 / 5 拿到图但校验不过
 */

require('./_deps.js');

const path = require('path');
const fs = require('fs');
const MxaiAdapter = require('./mxai_adapter.js');
const { inspectFile, describe: describeImg } = require('./verify_result.js');

const OUT = process.env.MJ_OUTPUT_DIR || path.join(__dirname, '..', 'output');
const ARCHIVE = process.env.MJ_ARCHIVE_DIR || path.join(__dirname, '..', 'archive');
const PROFILE = process.env.MXAI_PROFILE || 'E:/codex/niannianai/zhuanhuiyuangong/ai-rpa-console/.browser-profile';

function emit(payload) {
    process.stdout.write(JSON.stringify(payload));
}

(async () => {
    const numId = process.argv[2];
    const baseName = process.argv[3];
    const minW = parseInt(process.argv[4] || process.env.MJ_MIN_DIM || '1000', 10);
    const minH = parseInt(process.argv[5] || process.env.MJ_MIN_DIM || '1000', 10);
    if (!numId || !baseName) {
        console.error('usage: node dl_by_serial.js <serialNumId> <baseName> [minW] [minH]');
        process.exit(1);
    }
    const fullId = `serial-${numId}`;
    const opts = { minW, minH };

    const ad = new MxaiAdapter({
        headless: !(process.env.MXAI_HEADLESS === 'false'),
        userDataDir: PROFILE,
    });
    await ad.launch();
    await ad.navigate();
    await ad._dismissPopups();

    const found = await ad.page.evaluate((id) => !!document.getElementById(id), fullId).catch(() => false);
    if (!found) {
        emit({ ok: false, status: 'target_not_found', serial: fullId });
        await ad.close();
        process.exit(2);
    }

    // 等「下载」span（最多 3 分钟）
    let ready = false;
    for (let i = 0; i < 36 && !ready; i++) {
        ready = await ad.page.evaluate((id) => {
            const el = document.getElementById(id);
            return !!el && [...el.querySelectorAll('span')].some(s => (s.textContent || '').trim() === '下载');
        }, fullId).catch(() => false);
        if (!ready) await ad.page.waitForTimeout(5000);
    }
    if (!ready) console.error('WARN_DL_SPAN_TIMEOUT_still_trying');

    let fp = null;
    const rejected = [];

    const check = (file) => {
        const info = inspectFile(file, opts);
        if (info.ok) {
            console.error(`VERIFY_OK ${path.basename(file)} ${describeImg(info)}`);
            return true;
        }
        rejected.push({ file, verdict: info.verdict, reason: info.reason, bytes: info.bytes });
        console.error(`VERIFY_REJECT ${path.basename(file)} -> ${info.verdict}: ${info.reason}`);
        try { fs.unlinkSync(file); } catch (e) { /* 忽略 */ }
        return false;
    };

    const saveName = (ext) => path.join(OUT, `${path.basename(baseName, path.extname(baseName))}.${ext}`);

    // ===== 路 A/B：点「下载」span，最多 3 次；点击前清遮挡 + 校验落点 =====
    for (let attempt = 1; attempt <= 3 && !fp; attempt++) {
        console.error(`DL_ATTEMPT=${attempt}`);
        const span = ad.page.locator(`#${fullId} span`).filter({ hasText: /^下载$/ }).first();
        const visible = await span.isVisible().catch(() => false);
        if (!visible) { await ad._dismissPopups(); await ad.page.waitForTimeout(2000); continue; }

        await ad.page.keyboard.press('Escape').catch(() => {});
        await ad._dismissPopups().catch(() => {});
        await ad.page.waitForTimeout(800);

        const covered = await span.evaluate((el) => {
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit ? (el === hit || el.contains(hit) ? '' : (hit.className || '').toString().slice(0, 60)) : 'no-hit';
        }).catch(() => 'eval-err');
        console.error(`COVERED_BY=${covered || '(nothing)'}`);
        if (covered && covered !== 'eval-err' && covered !== 'no-hit') {
            await ad.page.keyboard.press('Escape').catch(() => {});
        }

        const [result] = await Promise.all([
            Promise.race([
                ad.page.waitForEvent('download', { timeout: 60000 }).then(d => ({ type: 'dl', d })).catch(() => null),
                ad.page.waitForEvent('popup', { timeout: 60000 }).then(p => ({ type: 'popup', p })).catch(() => null),
            ]),
            span.click({ timeout: 5000, force: true }).catch(() => {}),
        ]).catch(() => [null]);

        if (!result) { console.error('NO_EVENT'); continue; }
        let candidate = null;
        try {
            if (result.type === 'dl') {
                const suggested = result.d.suggestedFilename() || '';
                const m = suggested.match(/\.(png|jpe?g|webp|gif)$/i);
                const ext = m ? m[1].toLowerCase() : 'png';
                candidate = saveName(ext);
                await result.d.saveAs(candidate);
            } else {
                const p2 = result.p;
                await p2.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
                await p2.waitForTimeout(2500);
                const src = await p2.evaluate(() => {
                    const img = document.querySelector('img');
                    return img ? (img.currentSrc || img.src || '') : location.href;
                }).catch(() => '');
                console.error('POPUP_SRC=' + src.slice(0, 120));
                if (/^https?:/.test(src)) {
                    const resp = await ad.page.request.get(src, { headers: { Referer: 'https://www.mxai.cn/' }, timeout: 60000 });
                    if (resp.ok()) {
                        const buf = await resp.body();
                        const mt = (resp.headers()['content-type'] || '').match(/png|jpe?g|webp/);
                        const ext = mt ? (mt[0] === 'jpeg' ? 'jpg' : mt[0]) : 'png';
                        candidate = saveName(ext);
                        fs.writeFileSync(candidate, buf);
                    }
                }
                await p2.close().catch(() => {});
            }
        } catch (e) { console.error('ATTEMPT_ERR=' + e.message); candidate = null; }

        if (candidate && fs.existsSync(candidate) && check(candidate)) {
            fp = candidate;
        } else {
            fp = null;
        }
    }

    // ===== 路 C：灯箱兜底 =====
    if (!fp) {
        console.error('FALLBACK_LIGHTBOX');
        await ad.page.keyboard.press('Escape').catch(() => {});
        let opened = false;
        for (let t = 0; t < 3 && !opened; t++) {
            await ad.page.locator(`#${fullId} .el-image`).first().click({ timeout: 5000, force: true }).catch(() => {});
            opened = await ad.page.waitForSelector('.el-image-viewer__img', { timeout: 6000 }).then(() => true).catch(() => false);
            if (!opened) {
                await ad.page.locator('.el-image').first().click({ timeout: 5000, force: true }).catch(() => {});
                opened = await ad.page.waitForSelector('.el-image-viewer__img', { timeout: 6000 }).then(() => true).catch(() => false);
            }
            if (!opened) { await ad.page.keyboard.press('Escape').catch(() => {}); await ad.page.waitForTimeout(1000); }
        }
        if (opened) {
            await ad.page.waitForFunction(() => {
                const v = document.querySelector('.el-image-viewer__img');
                const s = v ? (v.currentSrc || v.src || '') : '';
                return s.includes('outputs');
            }, { timeout: 15000 }).catch(() => {});
            const src = await ad.page.evaluate(() => {
                const v = document.querySelector('.el-image-viewer__img');
                return v ? (v.currentSrc || v.src || '') : '';
            }).catch(() => '');
            console.error('LIGHTBOX_SRC=' + src.slice(0, 140));
            if (/^https?:/.test(src)) {
                const resp = await ad.page.request.get(src, { headers: { Referer: 'https://www.mxai.cn/' }, timeout: 90000 });
                if (resp.ok()) {
                    const buf = await resp.body();
                    const mt = (resp.headers()['content-type'] || '').match(/png|jpe?g|webp/);
                    const ext = mt ? (mt[0] === 'jpeg' ? 'jpg' : mt[0]) : 'webp';
                    const candidate = saveName(ext);
                    fs.writeFileSync(candidate, buf);
                    console.error(`LIGHTBOX_SAVED bytes=${buf.length}`);
                    if (check(candidate)) fp = candidate;
                } else { console.error('LIGHTBOX_FETCH_FAIL status=' + resp.status()); }
            }
            await ad.page.keyboard.press('Escape').catch(() => {});
        } else {
            console.error('LIGHTBOX_NOT_OPENED');
        }
    }

    if (!fp) {
        emit({ ok: false, status: 'download_failed', serial: fullId, rejected });
        await ad.close();
        process.exit(4);
    }

    const info = inspectFile(fp, opts);
    const dest = path.join(ARCHIVE, baseName.endsWith('.png') || baseName.endsWith('.webp') ? baseName : baseName + '.png');
    try {
        fs.mkdirSync(ARCHIVE, { recursive: true });
        fs.copyFileSync(fp, dest);
    } catch (e) {
        emit({ ok: false, status: 'archive_failed', file: fp, error: e.message, serial: fullId });
        await ad.close();
        process.exit(6);
    }

    emit({
        ok: true,
        status: 'ok',
        serial: fullId,
        file: fp,
        archived: dest,
        bytes: info.bytes,
        w: info.w,
        h: info.h,
        format: info.format,
        sha256: info.sha256,
        rejected,
    });

    await ad.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
