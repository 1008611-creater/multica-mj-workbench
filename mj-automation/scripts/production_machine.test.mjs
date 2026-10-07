import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { runBatch } from './production_machine.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const bridgeUrl = 'http://mock-bridge.invalid';
const tempDirs = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-retry-gate-'));
  tempDirs.push(dir);
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    project_id: 'retry-gate-test',
    batch_id: 'retry-gate-test',
    version: 'test',
    items: [{ batch: 'case', item_id: 'ITEM-1', generation_prompt: 'fixture prompt', aspect_ratio: '16:9' }],
  }), 'utf8');
  return {
    dir,
    argv: ['--manifest', manifestPath, '--batch', 'case', '--max-retries', '2', '--poll-ms', '1', '--receipts', path.join(dir, 'attempts.jsonl'), '--summary', path.join(dir, 'summary.json')],
  };
}

function mockRequest({ responses = {}, submitError = null } = {}) {
  const posts = [];
  const reads = [];
  return {
    posts,
    reads,
    request: async (url, options = {}) => {
      assert.ok(url.startsWith(bridgeUrl), `unexpected URL: ${url}`);
      if (options.method === 'POST') {
        const payload = JSON.parse(options.body);
        posts.push(payload);
        if (submitError) throw submitError;
        return { jobId: `job-${posts.length}`, status: 'running', deduped: false };
      }
      const jobId = decodeURIComponent(url.split('/').at(-1));
      reads.push(jobId);
      const response = responses[jobId];
      return typeof response === 'function' ? response() : response;
    },
  };
}

function readReceipt(dir) {
  return fs.readFileSync(path.join(dir, 'attempts.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const nonRetryCases = [
  ['business queued status', { status: 'done', ok: false, result: { status: 'queued', retryAllowed: false, billed: true } }],
  ['receipt_pending status', { status: 'done', ok: false, result: { status: 'receipt_pending', retry_allowed: false } }],
  ['download_failed status', { status: 'done', ok: false, result: { status: 'download_failed', retryAllowed: false, billed: true } }],
  ['need_login status even with contradictory flags', { status: 'done', ok: false, result: { status: 'need_login', retryAllowed: true, billed: false, chargeKnown: true } }],
  ['unknown deduction despite retryAllowed', { status: 'done', ok: false, result: { status: 'failed', retryAllowed: true, submitted: true } }],
  ['positive deduction despite retryAllowed', { status: 'done', ok: false, result: { status: 'aspect_not_applied', retryAllowed: true, billed: true, chargeKnown: true } }],
  ['page-reported failure with retry denied', { status: 'done', ok: false, result: { status: 'page_reported_failed', retryAllowed: false } }],
  ['top-level resultStatus and retryAllowed aliases', { status: 'done', ok: false, resultStatus: 'queued', retry_allowed: false, billed: true }],
];

for (const [name, response] of nonRetryCases) {
  test(`does not resubmit ${name}`, async () => {
    const f = fixture();
    const mock = mockRequest({ responses: { 'job-1': response } });
    const summary = await runBatch({ argv: f.argv, bridgeUrl, request: mock.request, wait: async () => {}, log: () => {} });
    assert.equal(mock.posts.length, 1);
    assert.equal(summary.results.length, 1);
    const terminal = readReceipt(f.dir).find((row) => row.event === 'terminal');
    assert.equal(terminal.attempt, 1);
    assert.equal(terminal.retry_allowed, response.result?.retryAllowed ?? response.result?.retry_allowed ?? response.retryAllowed ?? response.retry_allowed ?? false);
  });
}

test('retries only an explicitly permitted, confirmed no-charge failure', async () => {
  const f = fixture();
  const mock = mockRequest({ responses: {
    'job-1': { status: 'done', ok: false, result: { status: 'aspect_not_applied', retryAllowed: true, submitted: false, billed: false, chargeKnown: true } },
    'job-2': { status: 'done', ok: true, result: { status: 'ok', ok: true, billed: true } },
  } });
  const summary = await runBatch({ argv: f.argv, bridgeUrl, request: mock.request, wait: async () => {}, log: () => {} });
  assert.equal(mock.posts.length, 2);
  assert.equal(mock.posts[0].force, false);
  assert.equal(mock.posts[1].force, true);
  const terminals = readReceipt(f.dir).filter((row) => row.event === 'terminal');
  assert.equal(terminals.length, 2);
  assert.equal(terminals[1].attempt, 2);
  assert.equal(terminals[1].retry_of, 'job-1');
  assert.equal(summary.success_count, 1);
});

test('recognizes the /v1/jobs explicit zero-deduction fields', async () => {
  const f = fixture();
  const mock = mockRequest({ responses: {
    'job-1': { status: 'done', ok: false, resultStatus: 'aspect_not_applied', retryAllowed: true, chargeKnown: true, actualPointDeduction: 0 },
    'job-2': { status: 'done', ok: true, resultStatus: 'ok' },
  } });
  await runBatch({ argv: f.argv, bridgeUrl, request: mock.request, wait: async () => {}, log: () => {} });
  assert.equal(mock.posts.length, 2);
  const first = readReceipt(f.dir).find((row) => row.event === 'terminal');
  assert.equal(first.billed, false);
  assert.equal(first.charge_known, true);
  assert.equal(first.actual_point_deduction, 0);
});

test('does not resubmit after an ambiguous POST failure', async () => {
  const f = fixture();
  const error = new Error('HTTP 504');
  error.status = 504;
  error.body = { detail: { status: 'dispatch_timeout' } };
  const mock = mockRequest({ submitError: error });
  const summary = await runBatch({ argv: f.argv, bridgeUrl, request: mock.request, wait: async () => {}, log: () => {} });
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.reads.length, 0);
  assert.equal(summary.results[0].status, 'dispatch_timeout');
  assert.equal(summary.results[0].retry_allowed, false);
});

test('keeps polling an outer queued job and then records its nested business status', async () => {
  const f = fixture();
  let reads = 0;
  const mock = mockRequest({ responses: {
    'job-1': () => {
      reads += 1;
      return reads === 1
        ? { status: 'queued', ok: false }
        : { status: 'done', ok: false, result: { status: 'receipt_pending', retryAllowed: false } };
    },
  } });
  const summary = await runBatch({ argv: f.argv, bridgeUrl, request: mock.request, wait: async () => {}, log: () => {} });
  assert.equal(mock.posts.length, 1);
  assert.equal(reads, 2);
  assert.equal(summary.results[0].status, 'receipt_pending');
  assert.equal(summary.results[0].job_status, 'done');
});

after(() => {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  for (const dir of tempDirs) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(tempRoot)) throw new Error(`refusing to remove test path outside temp root: ${resolved}`);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});


test('detached runner writes to the configured jobs directory and preserves source parameters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-background-contract-'));
  tempDirs.push(dir);
  const adapterFile = path.join(dir, 'adapter.cjs');
  fs.writeFileSync(adapterFile, `module.exports = class {
    async launch() {} async navigate() {} async isLoggedIn() { return true; }
    async generate(prompt, options) {
      const f = require('node:path').join(options.outputDir, 'fixture.txt');
      require('node:fs').writeFileSync(f, 'contract fixture, not a production image');
      return {success:true, status:'ok', images:[f], submitted:true, recordId:'fixture-serial'};
    }
    async close() {}
  };`);
  const jobsDir = path.join(dir, 'isolated-jobs');
  const runner = fileURLToPath(new URL('./mj_run.js', import.meta.url));
  const env = {...process.env, MXAI_ADAPTER_PATH:adapterFile, MJ_JOBS_DIR:jobsDir};
  const dispatched = spawnSync(process.execPath, [runner, '--mode', 'bg:runner-fixture',
    '--prompt', 'original --s 120', '--source-prompt', 'original', '--params-json', '{"stylize":120}',
    '--out-dir', dir], {env, encoding:'utf8', timeout:15000});
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const dispatch = JSON.parse(dispatched.stdout);
  assert.equal(dispatch.resultFile, path.join(jobsDir, 'runner-fixture.json'));
  assert.equal(dispatch.logFile, path.join(jobsDir, 'runner-fixture.log'));
  let result;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { result = JSON.parse(fs.readFileSync(dispatch.resultFile, 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(result, 'detached result was not persisted');
  assert.equal(result.prompt, 'original');
  assert.equal(result.effectivePrompt, 'original --s 120');
  assert.deepEqual(result.params, {stylize:120});
  const queried = spawnSync(process.execPath, [runner, '--mode', 'job:runner-fixture'], {env, encoding:'utf8', timeout:15000});
  assert.equal(JSON.parse(queried.stdout).result.recordId, 'fixture-serial');
});

test('runner distinguishes an exception before submission from one after submission starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-submission-contract-'));
  tempDirs.push(dir);
  const runner = fileURLToPath(new URL('./mj_run.js', import.meta.url));
  for (const submitted of [false, true]) {
    const adapterFile = path.join(dir, 'adapter-' + submitted + '.cjs');
    fs.writeFileSync(adapterFile, `module.exports = class {
      async launch() { ${submitted ? '' : "throw Error('launch failed');"} }
      async navigate() {} async isLoggedIn() { return true; }
      async generate() { this._submissionStarted=true; throw Error('response lost'); }
      async close() {}
    };`);
    const run = spawnSync(process.execPath, [runner, '--prompt', 'fixture', '--out-dir', dir],
      {env:{...process.env, MXAI_ADAPTER_PATH:adapterFile}, encoding:'utf8', timeout:15000});
    assert.equal(run.status, 3);
    const result = JSON.parse(run.stdout);
    assert.equal(result.submitted, submitted ? undefined : false);
    assert.equal(result.billed, submitted ? undefined : false);
    assert.equal(result.retryAllowed, submitted ? undefined : true);
  }
});

// Exercise the polling race: failure appears only after the new serial is observed.
test('late platform failure preserves the target card reason without reading historical failures', async () => {
  const Adapter = createRequire(import.meta.url)('./mxai_adapter.js');
  const adapter = Object.create(Adapter.prototype);
  adapter._collectImageSrcs = async () => new Set();
  adapter._collectSerialIds = async () => new Set(['serial-123']);
  let targetReads = 0;
  const historical = {innerText: '绘图失败：历史失败，积分已自动退回'};
  adapter.page = {
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      const document = {
        body: {innerText: historical.innerText},
        getElementById: id => {
          assert.equal(id, 'serial-123');
          targetReads++;
          return {innerText: targetReads === 1 ? '正在生成' : 'MX 绘图失败：任务提交失败（积分已自动退回）', querySelectorAll: () => []};
        },
      };
      return vm.runInNewContext('(' + fn.toString() + ')(arg)', {document, arg});
    },
  };
  const result = await adapter.waitForResult(1000);
  assert.equal(result.status, 'page_reported_failed');
  assert.equal(result.recordId, 'serial-123');
  assert.match(result.message, /任务提交失败.*积分已自动退回/);
  assert.doesNotMatch(result.message, /历史失败/);
  assert.equal(result.billed, undefined, 'refund text does not prove a numeric charge');
});
test('queue distinguishes platform failure from an unknown receipt without inferring charges', () => {
  const source = fs.readFileSync(new URL('../control/batch-ui.js', import.meta.url), 'utf8');
  const helper = source.match(/function taskPhaseLabel\(row,job\)\{[^\n]+\}/)[0];
  const label = vm.runInNewContext('(' + helper + ')', {
    PHASE: {result_pending:'回执待核查',platform_generating:'平台生成中'},
    LABEL: {skipped:'已跳过',result_pending:'待核查'},
  });
  const failed = {resultStatus:'page_reported_failed',phase:'result_pending',submitted:true,billed:null};
  assert.equal(label({status:'result_pending'}, failed), '平台生成失败');
  assert.equal(label({status:'skipped'}, failed), '已跳过 · 平台生成失败');
  assert.equal(failed.billed, null);
  assert.equal(label({status:'result_pending'}, {phase:'result_pending'}), '回执待核查');
  assert.equal(label({status:'running'}, {phase:'platform_generating'}), '平台生成中');
});
// Run the real workbench functions with an isolated DOM/API contract, never a production browser profile.
function loginWorkbenchFixture(storage = new Map()) {
  const source = fs.readFileSync(new URL('../control/batch-ui.js', import.meta.url), 'utf8');
  const nodes = new Map();
  let opens = 0;
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {textContent:'',innerHTML:'',open:false,classList:{remove(){},add(){}},showModal(){this.open=true;opens++;},close(){this.open=false;}});
    return nodes.get(id);
  };
  const context = vm.createContext({
    URLSearchParams, location:{search:''},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    document:{getElementById:element,body:{classList:{add(){},remove(){}}}},
    setTimeout:()=>0, clearTimeout(){},
  });
  vm.runInContext(source.slice(0,source.indexOf("$('default-aspect').innerHTML")), context);
  return {context,element,storage,opens:()=>opens,run:code=>vm.runInContext(code,context)};
}
const loginBatch = (id='login-batch', profile='fixture-profile') => ({
  batchId:id,name:'Login fixture',status:'paused',profileMode:'per_slot',
  items:[{id:'item-1',name:'Fixture task',status:'login_required',slot:2,profile,
    currentJobId:'attempt-1',attempts:1,lastResult:{submitted:false,resultStatus:'need_login',phase:'result_pending'}}],
});
test('login reminder only includes confirmed unsubmitted login failures, including unselected batches', () => {
  const f = loginWorkbenchFixture();
  const batch = loginBatch();
  batch.items.push(...[true,null,undefined].map((submitted,i)=>({...batch.items[0],id:'unknown-'+i,lastResult:{submitted}})));
  batch.items.push({...batch.items[0],id:'pending-review',status:'result_pending'});
  const cancelled = {...loginBatch('cancelled'),status:'cancelled'};
  f.context.batches = [batch,loginBatch('unselected','other-profile'),cancelled];
  assert.equal(f.run('collectLoginAlerts(batches).length'),2);
  assert.equal(f.run('collectLoginAlerts(batches)[1].batchId'),'unselected');
  assert.equal(f.run("taskPhaseLabel(batches[0].items[0],{phase:'result_pending'})"),'需要登录');
});
test('login reminder defers during editing or operations, deduplicates the attempt, and permits a new attempt', () => {
  const f = loginWorkbenchFixture();
  f.context.batch = loginBatch();
  f.run('S.bridge={};S.loginAlerts=collectLoginAlerts([batch]);');
  f.element('modal').open=true;
  f.element('modal-title').textContent='Existing fee confirmation';
  f.run('maybeShowLoginReminder()');
  assert.equal(f.element('modal-title').textContent,'Existing fee confirmation');
  assert.equal(f.run('S.loginSeen.size'),0);
  f.element('modal').open=false;
  f.run('S.busy=true;maybeShowLoginReminder()');
  assert.equal(f.opens(),0);
  f.run('S.busy=false;maybeShowLoginReminder()');
  assert.equal(f.opens(),1);
  f.element('modal').open=false;
  f.run('maybeShowLoginReminder()');
  assert.equal(f.opens(),1);
  // Reloading the same origin must not cause the dismissed attempt to summon the person again.
  const reloaded = loginWorkbenchFixture(f.storage);
  reloaded.context.batch=loginBatch();
  reloaded.run('S.bridge={};S.loginAlerts=collectLoginAlerts([batch]);maybeShowLoginReminder()');
  assert.equal(reloaded.opens(),0);
  f.run("batch.items[0].currentJobId='attempt-2';batch.items[0].attempts=2;S.loginAlerts=collectLoginAlerts([batch]);maybeShowLoginReminder()");
  assert.equal(f.opens(),2);
});
test('login reminder respects a persistent off setting and remains manually accessible', () => {
  const f=loginWorkbenchFixture(new Map([['multica-login-reminder-v1','false']]));
  f.context.batch=loginBatch();
  f.run('S.bridge={};S.loginAlerts=collectLoginAlerts([batch]);maybeShowLoginReminder()');
  assert.equal(f.opens(),0);
  f.run('maybeShowLoginReminder(true)');
  assert.equal(f.opens(),1);
});
test('login popup routes only human-window and read-only checks to the exact batch and slot item', async () => {
  const f=loginWorkbenchFixture();
  f.context.batch=loginBatch('batch with / slash');
  const calls=[];
  f.context.record=(url,method,body)=>{calls.push({url,method,body});return {loggedIn:false,loginState:'logged_in'};};
  f.run('api=async(url,method,body)=>record(url,method,body);S.bridge={};S.loginAlerts=collectLoginAlerts([batch]);maybeShowLoginReminder()');
  await f.element('login-reminder-open').onclick();
  await f.element('login-reminder-check').onclick();
  assert.deepEqual(calls.map(c=>[c.url,c.method]),[
    ['/control/batches/batch%20with%20%2F%20slash/items/item-1/login','POST'],
    ['/control/batches/batch%20with%20%2F%20slash/items/item-1/login','GET'],
  ]);
  assert.equal(JSON.stringify(calls[0].body),'{}');
  assert.equal(calls[1].body,undefined);
  assert.match(f.element('login-reminder-status').textContent,/登录已核验.*确认本次费用/);
  assert.equal(f.context.batch.items[0].status,'login_required','checking must never requeue or submit');
  assert.equal(f.opens(),1);
});
test('login scan reads summaries across batches without letting one failed detail request mark the bridge offline', async () => {
  const f=loginWorkbenchFixture();
  const calls=[];
  f.context.active=loginBatch('active');
  f.context.hidden=loginBatch('hidden','hidden-profile');
  f.context.record=url=>{calls.push(url);if(url.endsWith('/broken'))throw Error('detail unavailable');return f.context.hidden;};
  f.run('api=async(url)=>record(url);S.bridge={ok:true};S.batch=active;');
  await f.run("updateLoginAlerts({batches:[{batchId:'active',counts:{login_required:1}},{batchId:'hidden',counts:{login_required:1}},{batchId:'broken',counts:{login_required:1}},{batchId:'other',counts:{completed:3}}]})");
  assert.deepEqual(calls,['/control/batches/hidden','/control/batches/broken']);
  assert.equal(f.run('S.loginAlerts.length'),2);
  assert.equal(f.run('S.bridge.ok'),true);
});
test('active login reminders do not cycle when more than 100 attempts still await a person', () => {
  const f=loginWorkbenchFixture();
  f.context.batches=Array.from({length:105},(_,i)=>loginBatch('active-'+i,'profile-'+i));
  f.run('S.bridge={};S.loginAlerts=collectLoginAlerts(batches);');
  for(let i=0;i<105;i++){f.element('modal').open=false;f.run('maybeShowLoginReminder()');}
  assert.equal(f.opens(),105);
  f.element('modal').open=false;
  f.run('maybeShowLoginReminder()');
  assert.equal(f.opens(),105,'still-active reminders must not be pruned into a new popup cycle');
  const reloaded=loginWorkbenchFixture(f.storage);
  reloaded.context.batches=f.context.batches;
  reloaded.run('S.bridge={};S.loginAlerts=collectLoginAlerts(batches);maybeShowLoginReminder()');
  assert.equal(reloaded.opens(),0);
});
// Queue filtering reads existing state; it never changes task order or dispatch eligibility.
test('queue filters combine status and case-insensitive search without mutating the source', () => {
 const f=loginWorkbenchFixture();
 f.context.rows=[{id:'a',name:'Forest',prompt:'green light',status:'pending'},{id:'b',name:'Night',prompt:'city',status:'result_pending',lastResult:{recordId:'serial-42',submitted:null}},{id:'c',name:'Done',prompt:'forest',status:'completed'},{id:'d',name:'Old',status:'skipped',lastResult:{resultStatus:'page_reported_failed'}}];
 const before=JSON.stringify(f.context.rows);
 assert.equal(f.run("queueRows(rows,'pending',' FOREST ').length"),1);
 assert.equal(f.run("queueRows(rows,'attention','SERIAL-42')[0].id"),'b');
 assert.equal(f.run("queueRows(rows,'all','forest').length"),2);
 assert.equal(f.run("queueRows(rows,'attention','missing').length"),0);
 assert.equal(f.run('queueGroup(rows[3])'),'skipped');
 assert.equal(JSON.stringify(f.context.rows),before);
});
test('queue guidance separates login, unknown submission, unsubmitted failure and platform failure', () => {
 const f=loginWorkbenchFixture();
 f.context.rows=[loginBatch().items[0],{status:'result_pending',lastResult:{submitted:null}},{status:'failed',lastResult:{submitted:false}},{status:'result_pending',lastResult:{submitted:true,billed:null,resultStatus:'page_reported_failed'}},{status:'skipped',lastResult:{submitted:true}}];
 assert.match(f.run('queueGuidance(rows[0])'),/手动登录/);
 assert.match(f.run('queueGuidance(rows[1])'),/请勿重复提交/);
 assert.match(f.run('queueGuidance(rows[2])'),/确认尚未提交/);
 assert.match(f.run('queueGuidance(rows[3])'),/核对平台退款记录.*费用未核实/);
 assert.equal(f.context.rows[3].lastResult.billed,null);
 assert.equal(f.run('queueGuidance(rows[4])'),'');
});
test('queue rendering preserves real task counts and does not expose an empty or blocked paid start', () => {
 const f=loginWorkbenchFixture();
 f.context.batch={...loginBatch(),items:[{id:'done',name:'<unsafe>',prompt:'x',status:'completed'},loginBatch().items[0]]};
 f.run("S.bridge={batches:[]};S.batch=batch;S.queueFilter='attention';renderQueue()");
 let html=f.element('batch-detail').innerHTML;
 assert.ok(html.includes('当前显示 1 / 2 项'));
 assert.match(html,/手动登录/);
 assert.doesNotMatch(html,/data-batch-action="resume"/);
 assert.doesNotMatch(html,/<unsafe>/);
 f.run("S.queueSearch='no-match';renderQueue()");
 assert.match(f.element('batch-detail').innerHTML,/没有符合条件的任务/);
 f.context.batch.items=[{id:'pending',status:'pending',name:'Waiting',prompt:'x'}];
 f.run("S.queueSearch='';renderQueue()");
 assert.match(f.element('batch-detail').innerHTML,/data-batch-action="resume"/);
 f.context.batch.items=[];
 f.run('renderQueue()');
 assert.doesNotMatch(f.element('batch-detail').innerHTML,/data-batch-action="resume"/);
});

test('queue polling leaves an active Chinese input composition untouched until it commits', () => {
 const f=loginWorkbenchFixture();
 f.context.batch=loginBatch();
 f.run('S.bridge={batches:[]};S.batch=batch;renderQueue()');
 const initial=f.element('batch-detail').innerHTML;
 f.run("S.queueComposing=true;S.queueSearch='no-match';renderQueue()");
 assert.equal(f.element('batch-detail').innerHTML,initial);
 f.run('S.queueComposing=false;renderQueue()');
 assert.match(f.element('batch-detail').innerHTML,/没有符合条件的任务/);
});