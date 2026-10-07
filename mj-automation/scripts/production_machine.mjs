#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BRIDGE = process.env.MJ_BRIDGE_URL || 'http://127.0.0.1:8765';
const DEFAULT_LEDGER = path.join(ROOT, 'mj-automation', 'receipts');
const MISSING = '\u7f3a';
const EXECUTION_STATUSES = new Set(['running', 'queued', 'done', 'stale', 'unknown']);
const NON_RETRYABLE_RESULT_STATUSES = new Set([
  'queued', 'receipt_pending', 'download_failed', 'need_login',
  'timeout', 'poll_error', 'unknown', 'stale', 'submission_unknown',
]);
const SAFE_RETRY_RESULT_STATUSES = new Set([
  'aspect_not_applied', 'validation_failed', 'preflight_failed',
  'dispatch_failed', 'failed', 'exception',
]);

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[name] = true;
    else { out[name] = next; i += 1; }
  }
  return out;
}
function safeName(value) { return String(value).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80); }
function iso() { return new Date().toISOString(); }
function sha256(file) { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(file)); return h.digest('hex'); }
function dims(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      if (b.toString('ascii', 12, 16) === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (b.toString('ascii', 12, 16) === 'VP8 ') {
        const p = b.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
        if (p >= 0) return { width: b.readUInt16LE(p + 3) & 0x3fff, height: b.readUInt16LE(p + 5) & 0x3fff };
      }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) { p += 1; continue; }
        const m = b[p + 1];
        const len = b.readUInt16BE(p + 2);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
        p += 2 + len;
      }
    }
  } catch (_) { /* return unknown dimensions */ }
  return { width: null, height: null };
}
async function jsonRequest(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
function writeLine(file, object) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(object)}\n`, 'utf8'); }
function imageReceipt(images) {
  return (images || []).map((file) => {
    const p = path.resolve(file);
    const exists = fs.existsSync(p);
    const d = dims(p);
    return { file: p, exists, width: d.width, height: d.height, sha256: exists ? sha256(p) : MISSING };
  });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function firstBoolean(...values) { return values.find((value) => typeof value === 'boolean'); }
function firstString(...values) { return values.find((value) => typeof value === 'string' && value.trim()) || null; }

function normalizeJobResponse(body = {}) {
  const wrapper = body && typeof body === 'object' ? body : {};
  const result = wrapper.result && typeof wrapper.result === 'object' ? wrapper.result : wrapper;
  const executionStatus = firstString(wrapper.status) || MISSING;
  const resultStatus = firstString(
    wrapper.resultStatus,
    wrapper.result_status,
    wrapper.result && typeof wrapper.result === 'object' ? result.status : null,
    !EXECUTION_STATUSES.has(executionStatus) ? executionStatus : null,
  );
  const submitted = firstBoolean(wrapper.submitted, result.submitted);
  const deduction = typeof wrapper.actualPointDeduction === 'number'
    ? wrapper.actualPointDeduction
    : result.actual_point_deduction;
  const billed = firstBoolean(wrapper.billed, result.billed)
    ?? (submitted === false ? false : (typeof deduction === 'number' ? deduction > 0 : undefined));
  const retryAllowed = firstBoolean(
    wrapper.retryAllowed,
    wrapper.retry_allowed,
    result.retryAllowed,
    result.retry_allowed,
  );
  return {
    executionStatus,
    resultStatus: resultStatus ? resultStatus.toLowerCase() : null,
    retryAllowed,
    submitted,
    billed,
    actualPointDeduction: typeof deduction === 'number' ? deduction : null,
    chargeKnown: firstBoolean(wrapper.chargeKnown, wrapper.charge_known, result.chargeKnown, result.charge_known)
      ?? (typeof billed === 'boolean'),
    ok: executionStatus === 'done' && (wrapper.ok === true || result.ok === true),
    images: Array.isArray(wrapper.images) ? wrapper.images : (Array.isArray(result.images) ? result.images : []),
    serial: wrapper.recordId || wrapper.serial || result.recordId || result.serial || MISSING,
    aspect: wrapper.aspect || result.aspect || MISSING,
  };
}

function mayRetry(normalized) {
  return !normalized.ok
    && Boolean(normalized.resultStatus)
    && !NON_RETRYABLE_RESULT_STATUSES.has(normalized.resultStatus)
    && SAFE_RETRY_RESULT_STATUSES.has(normalized.resultStatus)
    && normalized.retryAllowed === true
    && normalized.billed === false
    && normalized.chargeKnown === true;
}

function loadSeenArtifacts(receiptFile) {
  const serials = new Set();
  const hashes = new Set();
  const dir = path.dirname(receiptFile);
  if (!fs.existsSync(dir)) return { serials, hashes };
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('-attempts.jsonl')) continue;
    try {
      const rows = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of rows) {
        const row = JSON.parse(line);
        if (row.event !== 'terminal' || row.ok !== true) continue;
        if (row.serial && row.serial !== MISSING) serials.add(String(row.serial));
        for (const image of row.images || []) {
          if (image && image.exists && image.sha256 && image.sha256 !== MISSING) hashes.add(String(image.sha256));
        }
      }
    } catch (_) { /* ignore malformed historical lines */ }
  }
  return { serials, hashes };
}

export async function runBatch({
  argv = process.argv.slice(2),
  bridgeUrl = BRIDGE,
  request = jsonRequest,
  wait = sleep,
  log = console.log,
} = {}) {
  const a = argsOf(argv);
  const manifestPath = path.resolve(a.manifest || path.join(ROOT, 'projects', 'whale-pilot', 'prompts', 'whale-pilot-manifest.json'));
  const batch = String(a.batch || '').trim();
  if (!batch) throw new Error('--batch is required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const all = (manifest.items || []).filter((x) => x.batch === batch);
  if (!all.length) throw new Error(`Batch not found or empty: ${batch}`);
  const batchId = manifest.batch_id || `${manifest.project_id}-${batch}`;
  const maxActive = Math.min(3, Math.max(1, Number(a.concurrency || 3)));
  const pollMs = Math.max(5000, Number(a['poll-ms'] || 30000));
  const defaultRetries = Math.max(0, Number(a['max-retries'] ?? 1));
  const receiptFile = path.resolve(a.receipts || path.join(DEFAULT_LEDGER, `${batchId}-attempts.jsonl`));
  const summaryFile = path.resolve(a.summary || path.join(DEFAULT_LEDGER, `${batchId}-summary.json`));
  if (a['dry-run']) {
    console.log(JSON.stringify({ batch_id: batchId, count: all.length, concurrency: maxActive, max_retries: defaultRetries, items: all.map((x) => ({ item_id: x.item_id, kind: x.kind, aspect: x.aspect_ratio, prompt: x.generation_prompt })) }, null, 2));
    return;
  }

  const { serials: seenSerials, hashes: seenHashes } = loadSeenArtifacts(receiptFile);
  const pending = all.map((item) => ({ item, attempt: 1, retryOf: null }));
  const active = new Map();
  const results = [];
  const started = iso();

  const submit = async (entry) => {
    const { item, attempt, retryOf } = entry;
    const label = safeName(`${batchId}-${item.item_id}${attempt > 1 ? `-r${attempt}` : ''}`);
    const payload = { prompt: item.generation_prompt, aspect: item.aspect_ratio || '16:9', label, version: manifest.version || 'v8.2', force: attempt > 1 };
    try {
      const body = await request(`${bridgeUrl}/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const jobId = body.jobId;
      if (!jobId) throw new Error('bridge response missing jobId');
      const rec = { time: iso(), event: 'submitted', batch_id: batchId, item_id: item.item_id, attempt, retry_of: retryOf || MISSING, job_id: jobId, deduped: body.deduped === true, label, prompt_sha256: crypto.createHash('sha256').update(item.generation_prompt).digest('hex'), aspect: item.aspect_ratio || '16:9', actual_point_deduction: MISSING };
      writeLine(receiptFile, rec);
      active.set(jobId, { ...entry, jobId, label, submittedAt: rec.time });
    } catch (error) {
      const detail = error?.body?.detail && typeof error.body.detail === 'object' ? error.body.detail : {};
      const possibleJobId = typeof detail.jobId === 'string' ? detail.jobId : null;
      const rec = { time: iso(), event: possibleJobId ? 'submit_uncertain' : 'submit_failed', batch_id: batchId, item_id: item.item_id, attempt, retry_of: retryOf || MISSING, job_id: possibleJobId || MISSING, status: possibleJobId ? 'submission_unknown' : (detail.status || 'submit_failed'), retry_allowed: false, submitted: MISSING, billed: MISSING, charge_known: false, error: String(error.message || error), http_status: error.status || MISSING, actual_point_deduction: MISSING };
      writeLine(receiptFile, rec);
      if (possibleJobId) active.set(possibleJobId, { ...entry, jobId: possibleJobId, label, submittedAt: rec.time, submitUncertain: true });
      else results.push(rec);
    }
  };

  const terminal = async (job, body) => {
    const entry = active.get(job);
    if (!entry) return;
    active.delete(job);
    const item = entry.item;
    const attempt = entry.attempt;
    const normalized = normalizeJobResponse(body);
    let ok = normalized.ok;
    const images = imageReceipt(normalized.images);
    const serial = normalized.serial;
    const duplicateSerial = ok && serial !== MISSING && seenSerials.has(String(serial));
    const duplicateHash = ok && images.some((image) => image.exists && image.sha256 && image.sha256 !== MISSING && seenHashes.has(String(image.sha256)));
    const rec = { time: iso(), event: 'terminal', batch_id: batchId, item_id: item.item_id, attempt, retry_of: entry.retryOf || MISSING, job_id: job, status: normalized.resultStatus || MISSING, job_status: normalized.executionStatus, ok, retry_allowed: normalized.retryAllowed ?? MISSING, submitted: normalized.submitted ?? MISSING, billed: normalized.billed ?? MISSING, charge_known: normalized.chargeKnown, serial, images, aspect: normalized.aspect, actual_point_deduction: normalized.actualPointDeduction ?? MISSING };
    if (duplicateSerial || duplicateHash) {
      ok = false;
      rec.ok = false;
      rec.validation = 'duplicate_serial_or_hash';
      rec.duplicate_serial = duplicateSerial;
      rec.duplicate_hash = duplicateHash;
    }
    writeLine(receiptFile, rec);
    results.push(rec);
    if (ok) {
      if (serial !== MISSING) seenSerials.add(String(serial));
      for (const image of images) {
        if (image.exists && image.sha256 && image.sha256 !== MISSING) seenHashes.add(String(image.sha256));
      }
    }
    if (!normalized.ok && mayRetry(normalized)) {
      const limit = item.max_retries ?? defaultRetries;
      if (attempt <= limit) pending.unshift({ item, attempt: attempt + 1, retryOf: job });
    }
  };

  const fill = async () => { while (active.size < maxActive && pending.length) await submit(pending.shift()); };
  await fill();
  while (active.size || pending.length) {
    if (active.size) {
      await wait(pollMs);
      const jobs = [...active.keys()];
      const statuses = await Promise.all(jobs.map(async (job) => {
        try { return [job, await request(`${bridgeUrl}/v1/jobs/${encodeURIComponent(job)}`)]; }
        catch (error) { return [job, { status: 'poll_error', ok: false, error: String(error.message || error), http_status: error.status || MISSING }]; }
      }));
      for (const [job, body] of statuses) {
        if (['running', 'queued'].includes(body.status)) continue;
        await terminal(job, body);
      }
      await fill();
    } else await fill();
  }

  const summary = { batch_id: batchId, manifest: manifestPath, started_at: started, finished_at: iso(), planned_count: all.length, terminal_count: results.length, success_count: results.filter((x) => x.ok).length, failed_count: results.filter((x) => !x.ok).length, concurrency: maxActive, results };
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBatch().catch((error) => { console.error(JSON.stringify({ ok: false, status: 'runner_error', error: String(error.message || error) })); process.exitCode = 1; });
}
