#!/usr/bin/env node
require('./_deps.js');
const fs = require('node:fs');
const path = require('node:path');
const MxaiAdapter = require('./mxai_adapter.js');

const ROOT = path.resolve(__dirname, '..');
const STATE = process.env.MXAI_CONTROL_STATE || path.join(ROOT, 'run', 'control-browser.json');
const STOP_FILE = process.env.MXAI_CONTROL_STOP_FILE || '';
const localProfile = path.join(ROOT, 'runtime', 'browser-profile');
const legacyProfile = 'E:/codex/niannianai/zhuanhuiyuangong/ai-rpa-console/.browser-profile';
const PROFILE = process.env.MXAI_PROFILE || (fs.existsSync(localProfile) ? localProfile : legacyProfile);
const URL = process.env.MXAI_URL || 'https://www.mxai.cn/home/?mp=mjdrawai&from=invite&invite_id=100595351#/mj';
let adapter = null;
let stopping = false;

function writeState(patch) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ ...prev, ...patch, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function stop(reason='stopped') {
  if (stopping) return;
  stopping = true;
  writeState({ running: false, status: reason, lastEvent: reason });
  try { if (adapter) await adapter.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => stop('stopped_by_user'));
process.on('SIGTERM', () => stop('stopped_by_console'));

(async () => {
  writeState({ running: true, status: 'starting', loggedIn: false, lastEvent: 'launching' });
  adapter = new MxaiAdapter({ headless: false, userDataDir: PROFILE });
  try {
    await adapter.launch();
    await adapter.navigate({ waitForWorkspace: false });
    let loginState = await adapter.getLoginState();
    let loggedIn = loginState === 'logged_in';
    writeState({ running: true, status: loginState, loginState, loggedIn, lastEvent: 'browser_ready', url: adapter.page?.url?.() || URL });
    while (!stopping) {
      await sleep(1000);
      if (STOP_FILE && fs.existsSync(STOP_FILE)) {
        try { fs.unlinkSync(STOP_FILE); } catch (_) {}
        return stop('stopped_by_console');
      }
      if (!adapter.context || !adapter.page || adapter.page.isClosed()) return stop('browser_closed');
      loginState = await adapter.getLoginState().catch(() => 'unknown');
      loggedIn = loginState === 'logged_in';
      writeState({ running: true, status: loginState, loginState, loggedIn, lastEvent: 'watching', url: adapter.page.url() });
    }
  } catch (error) {
    writeState({ running: false, status: 'error', loggedIn: false, lastEvent: String(error.message || error) });
    try { if (adapter) await adapter.close(); } catch (_) {}
    process.exitCode = 1;
  }
})();

