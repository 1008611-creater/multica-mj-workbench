/**
 * 提示词提交前安全扫描（本地只读：不出图、不联网、不扣积分）
 *
 * 为什么需要：MXAI v8.2 解析器对「带连字符合成词」与「全大写拉丁缩写」会误判成未知参数，
 * 导致整单失败。失败虽会退积分，但一次往返十几分钟，代价是时间与排队位。
 * 所以在提交前先在本地拦一道：把风险词找出来，并给出中文替换建议。
 *
 * 【2026-09-13】新增 content_risk 一类：平台内容审查会把「否定句里的敏感词」照样命中
 * （写「不要 X」，它看到的是「X」）。实测 M03/M04 因此被判「生成失败」。此类只提示、不阻断。
 *
 * 用法：
 *   node prompt_guard.js --text "提示词正文..."
 *   node prompt_guard.js --file <含提示词的 txt/md 文件>
 *   node prompt_guard.js --scan-dir <目录> [--ext .md]
 * stdout 单行 JSON：{ok,status,reports[],message}
 * ok=false 表示有风险；本脚本只报告，绝不修改任何文件。
 */

const fs = require('fs');
const path = require('path');

// 替换建议表：键为英文风险词，值为推荐的中文写法。
const REPLACEMENTS = {
  '8K': '极致锐利', '4K': '极致清晰', '2K': '高清', 'UHD': '超高清',
  'HDR': '高动态范围', 'IMAX': '巨幕电影', 'CG': '三维渲染', 'CGI': '三维渲染',
  'VFX': '特效', 'SFX': '音效', 'PBR': '物理材质', 'OTS': '肩后视角',
  'FOV': '视场角', 'DOF': '景深', 'AO': '环境光遮蔽', 'SSS': '次表面散射',
  'HUD': '界面元素', 'UI': '界面', 'LUT': '调色', 'RGB': '三色通道',
};

// 白名单：这些大写词是必须保留的参数名，不算风险。
const ACRONYM_ALLOW = new Set([
  'MJ', 'MXAI', 'API', 'ID', 'URL', 'JSON', 'SREF', 'OREF', 'AR', 'HD', 'RAW', 'SW', 'NO', 'AI',
]);

// 画质词：正文规则明确禁止，统一改中文或删除。
const QUALITY_WORDS = [
  /\b8K\b/g, /\b4K\b/g, /\b2K\b/g, /\bUHD\b/g, /\bHDR\b/g, /\bIMAX\b/g,
  /\bmasterpiece\b/gi, /\bbest quality\b/gi, /\bultra[-\s]?detailed\b/gi,
];

// 平台内容过滤风险（只提示、不阻断）。
// 高优先：否定式排除项里出现敏感词——站内审查照样命中，是 M03/M04 判「生成失败」的真因。
// 低优先：正文里的敏感词本身，建议尽量改成正面表述，降低被拦概率。
const CONTENT_RISK_NEGATION = /不[^，。；,;\n]{0,8}?(性感|暴露|裸露|裸体|裸|成熟|色情|情色|凶|杀|血|獠牙|恐怖|暴力|未成年|幼态|幼)/g;
const CONTENT_RISK_WORDS = [
  /未成年/g, /十四五/g, /十三四/g, /性感/g, /暴露/g, /裸露/g, /獠牙/g,
  /\bteen\b/gi, /\bsexy\b/gi, /\bseductive\b/gi, /\bnudity\b/gi, /\bloli\b/gi,
];
const CONTENT_RISK_ADVICE = "改写为正面表述：把「不要 X」写成「要 Y」（例：不性感化 → 衣着规整端严、气质清雅端方）";

// 参数令牌：正文中段出现参数时提示统一挪到末尾。
const PARAM_TOKEN = /(^|\s)--(v|ar|aspect|s|stylize|style|c|chaos|no|raw|hd|q|quality|sw|iw|sref|oref|cref|seed|repeat|tile|weird|fast|relax|niji|profile|p)\b/gi;

function lineOf(body, index) {
  return body.slice(0, index).split(/\r?\n/).length;
}

function collect(text) {
  const body = String(text == null ? '' : text);
  const findings = [];
  const suggestions = [];
  let m = null;

  // 1) 全大写拉丁缩写
  const acro = /\b[A-Z][A-Z0-9]{1,7}\b/g;
  while ((m = acro.exec(body)) !== null) {
    const word = m[0];
    if (ACRONYM_ALLOW.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    if (/^M\d{2}$/.test(word)) continue;
    findings.push({ kind: 'latin_acronym', word, index: m.index, line: lineOf(body, m.index) });
    suggestions.push({ word, to: REPLACEMENTS[word] || null });
  }

  // 2) 带连字符合成词
  const hyph = /\b[A-Za-z]{2,}-[A-Za-z]{2,}\b/g;
  while ((m = hyph.exec(body)) !== null) {
    findings.push({ kind: 'hyphenated', word: m[0], index: m.index, line: lineOf(body, m.index) });
  }

  // 3) 画质词
  for (const re of QUALITY_WORDS) {
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) {
      const word = m[0];
      if (ACRONYM_ALLOW.has(word)) continue;
      if (findings.some((f) => f.index === m.index && f.word === word)) continue;
      findings.push({ kind: 'quality_word', word, index: m.index, line: lineOf(body, m.index) });
      suggestions.push({ word, to: REPLACEMENTS[word.toUpperCase()] || null });
    }
  }

  // 4) 参数出现在正文中段（--no 之后的排除项不算）
  const head = body.replace(/--no[\s\S]*$/i, '');
  PARAM_TOKEN.lastIndex = 0;
  while ((m = PARAM_TOKEN.exec(head)) !== null) {
    const tail = head.slice(m.index + m[0].length);
    if (tail.replace(/[\s,，。;；]/g, '').length < 4) continue;
    findings.push({ kind: 'param_in_body', word: m[0].trim(), index: m.index, line: lineOf(body, m.index) });
  }

  // 5) 平台内容过滤风险（否定式排除项 + 正文敏感词）
  CONTENT_RISK_NEGATION.lastIndex = 0;
  while ((m = CONTENT_RISK_NEGATION.exec(body)) !== null) {
    findings.push({ kind: 'content_risk', level: 'high', word: m[0], index: m.index, line: lineOf(body, m.index) });
    suggestions.push({ word: m[0], to: CONTENT_RISK_ADVICE });
  }
  for (const re of CONTENT_RISK_WORDS) {
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) {
      const word = m[0];
      if (findings.some((f) => f.index === m.index)) continue;
      findings.push({ kind: 'content_risk', level: 'low', word, index: m.index, line: lineOf(body, m.index) });
      suggestions.push({ word, to: CONTENT_RISK_ADVICE });
    }
  }

  const seen = new Set();
  const dedup = [];
  for (const f of findings) {
    const key = f.kind + '|' + f.word + '|' + f.index;
    if (seen.has(key)) continue;
    seen.add(key); dedup.push(f);
  }
  const seenSug = new Set();
  const dedupSug = [];
  for (const s of suggestions) {
    const key = s.word + '->' + (s.to || '');
    if (seenSug.has(key)) continue;
    seenSug.add(key); dedupSug.push(s);
  }
  return { findings: dedup, suggestions: dedupSug };
}

// 从 Markdown 里抽取「会提交的提示词块」——只扫真正会提交的那段，
// 避免把说明文字、资产编号表、验收标准误判成风险词。
function extractTextBlocks(md) {
  // 【2026-09-12.8】按行做围栏状态机，只收集 text / txt / 无语言标记的代码块。
  // 旧写法用单条正则，会把 ```json / ```powershell 这类块的**收尾围栏**误当成下一个块的开始，
  // 结果把紧随其后的正文吞进来一起扫，产生假警报（实测：01 与 03 两份文档各报 1~3 个假风险词）。
  const src = String(md == null ? '' : md);
  const lines = src.split(/\r?\n/);
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/.exec(lines[i]);
    if (fence) {
      if (open === null) {
        open = { lang: fence[1].toLowerCase(), startLine: i + 1, body: [] };
      } else {
        const lang = open.lang;
        const startLine = open.startLine;
        const body = open.body.join('\n').trim();
        open = null;
        // 只认「会提交的提示词」：text / txt / 无语言标记的块。
        if (lang !== '' && lang !== 'text' && lang !== 'txt') continue;
        if (!body) continue;
        // 纯参数块（-- 开头）跳过；表格 / 流程图块按制表符连线字符排除。
        if (/^\s*--/.test(body)) continue;
        if (/[\u2500-\u257F\u2190-\u21FF\u25A0-\u25FF\u2713\u2714\u2705]/.test(body)) continue;
        blocks.push({ text: body, line: startLine });
      }
      continue;
    }
    if (open !== null) open.body.push(lines[i]);
  }
  return blocks;
}

// 【2026-09-12.9】真会提交的那一段：含中文的块。
// 修掉旧判据的假绿：旧写法按「中文占比 >= 0.4」过滤，会把「极致清晰 4K 画质，close-up 特写」
// 这种中英混排的真提示词整块跳过，闸门照样报绿，风险词直接漏到提交环节。
function extractPromptBlocks(md) {
  return extractTextBlocks(md).filter(function (b) { return /[\u4e00-\u9fa5]/.test(b.text); });
}

// 纯英文块是文档里的「参考备份版」，不是提交路径，但也不假装看不见：单独提示，不判失败。
function extractReferenceBlocks(md) {
  return extractTextBlocks(md).filter(function (b) { return !/[\u4e00-\u9fa5]/.test(b.text); });
}

// 【2026-09-12.10】文件级「仅参考」标记。
// 为什么需要：有些文档整篇都是风格锚备份，连中文块也不进提交路径。
// 若按「含中文=提交路径」硬判，备份文档里的英文缩写会被误报成风险词，淹没真提交路径的判断。
// 约定：文档里出现下面任一标记，即视为仅参考——所有块只汇总提示，不计入 dirty。
const REFERENCE_ONLY_MARKERS = [
  /prompt-guard:\s*reference-only/i,
  /提示词闸门[：:]\s*仅参考/,
  /本文件不进入提交路径/,
];

function isReferenceOnly(md) {
  const src = String(md == null ? '' : md);
  return REFERENCE_ONLY_MARKERS.some(function (re) { return re.test(src); });
}

// 对 Markdown 提交卡：主扫「可提交的提示词块」，另附英文参考块的提示。
function scanMarkdown(md, options) {
  const opts = options || {};
  const referenceOnly = opts.referenceOnly === true || isReferenceOnly(md);
  const blocks = referenceOnly ? [] : extractPromptBlocks(md);
  const reports = [];
  // content_risk 与硬风险分开收集：硬风险只在 dirty 时进 reports，
  // 但内容审查风险必须从**全部块**汇总——干净块里同样可能有敏感词（实测 M04 原卡就是这种）。
  const contentRisks = [];
  for (const b of blocks) {
    const r = scanText(b.text);
    for (const f of (r.contentRisks || [])) contentRisks.push({ ...f, blockLine: b.line });
    if (r.ok) continue;
    reports.push({ blockLine: b.line, ...r });
  }
  const total = reports.reduce((n, r) => n + r.total, 0);
  const blocking = reports.reduce((n, r) => n + r.blocking, 0);
  const findings = [];
  const suggestions = [];
  for (const r of reports) {
    for (const f of r.findings) findings.push({ ...f, blockLine: r.blockLine });
    for (const g of r.suggestions) if (!suggestions.some((x) => x.word === g.word)) suggestions.push(g);
  }
  // 参考块（纯英文备份版）：只提示、不计入 dirty，避免淹没真提交路径的判断。
  // 仅参考的文档：中文块也一并归入参考提示，不判失败。
  const referenceBlocks = referenceOnly ? extractTextBlocks(md) : extractReferenceBlocks(md);
  const referenceWords = [];
  for (const b of referenceBlocks) {
    const r = scanText(b.text);
    if (r.ok) continue;
    for (const f of r.findings) if (referenceWords.indexOf(f.word) === -1) referenceWords.push(f.word);
  }
  return {
    ok: total === 0,
    status: total === 0 ? 'clean' : (blocking ? 'blocked' : 'warn'),
    blocks: blocks.length,
    blocking,
    total,
    findings,
    suggestions,
    contentRisks,
    reference: { blocks: referenceBlocks.length, words: referenceWords, only: referenceOnly },
  };
}

function scanText(text) {
  const { findings, suggestions } = collect(text);
  // content_risk 单列：平台内容审查风险只提示、不阻断（判失败会让人白等十几分钟，
  // 但把它当阻断又会让所有含敏感词的历史卡全部报红，失去信号价值）。
  const contentRisks = findings.filter((f) => f.kind === 'content_risk');
  const hard = findings.filter((f) => f.kind !== 'content_risk');
  const blocking = hard.filter((f) => f.kind === 'latin_acronym' || f.kind === 'hyphenated');
  return {
    ok: hard.length === 0,
    status: hard.length === 0 ? 'clean' : (blocking.length ? 'blocked' : 'warn'),
    blocking: blocking.length,
    total: hard.length,
    findings: hard,
    suggestions,
    contentRisks,
  };
}

function emit(payload) { process.stdout.write(JSON.stringify(payload)); }

function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { args[name] = 'true'; continue; }
    args[name] = next; i += 1;
  }
  const targets = [];
  if (args.text) targets.push({ label: '(inline)', text: String(args.text) });
  if (args.file) {
    const f = path.resolve(args.file);
    if (!fs.existsSync(f)) { emit({ ok: false, status: 'not_found', file: f, message: '找不到文件' }); process.exitCode = 1; return; }
    targets.push({ label: f, text: fs.readFileSync(f, 'utf8'), kind: /\.md$/i.test(f) ? 'md' : 'text' });
  }
  if (args['scan-dir']) {
    const dir = path.resolve(args['scan-dir']);
    const exts = String(args.ext || '.md,.txt').split(',').map((s) => s.trim()).filter(Boolean);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { emit({ ok: false, status: 'dir_not_found', dir, message: '找不到目录' }); process.exitCode = 1; return; }
    for (const n of names) {
      if (!exts.some((e) => n.toLowerCase().endsWith(e.toLowerCase()))) continue;
      targets.push({ label: path.join(dir, n), text: fs.readFileSync(path.join(dir, n), 'utf8'), kind: /\.md$/i.test(n) ? 'md' : 'text' });
    }
  }
  if (!targets.length) { emit({ ok: false, status: 'bad_request', message: '需要 --text / --file / --scan-dir 之一' }); process.exitCode = 1; return; }
  const reports = targets.map((t) => Object.assign({ label: t.label }, (t.kind === 'md' ? scanMarkdown(t.text) : scanText(t.text))));
  const dirty = reports.filter((r) => !r.ok);
  const words = [];
  for (const r of dirty) for (const f of r.findings) if (words.indexOf(f.word) === -1) words.push(f.word);
  // 内容审查风险：跨全部报告汇总（含干净报告），只作提示。
  const contentRiskWords = [];
  for (const r of reports) for (const f of (r.contentRisks || [])) if (contentRiskWords.indexOf(f.word) === -1) contentRiskWords.push(f.word);
  emit({
    ok: dirty.length === 0,
    status: dirty.length === 0 ? 'clean' : 'dirty',
    scanned: reports.length,
    dirty: dirty.length,
    reports,
    contentRiskWords,
    message: 'PROMPT_GUARD ' + JSON.stringify({ scanned: reports.length, dirty: dirty.length, words, contentRiskWords }),
  });
  process.exitCode = dirty.length ? 2 : 0;
}

if (require.main === module) main();

module.exports = { scanText, scanMarkdown, extractTextBlocks, extractPromptBlocks, extractReferenceBlocks, collect, isReferenceOnly, REFERENCE_ONLY_MARKERS, REPLACEMENTS, ACRONYM_ALLOW, CONTENT_RISK_NEGATION, CONTENT_RISK_WORDS, CONTENT_RISK_ADVICE };
