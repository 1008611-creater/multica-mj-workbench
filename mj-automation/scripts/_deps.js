/**
 * 依赖解析补丁（本目录专用）
 *
 * 背景：mxai_adapter.js 改造副本放在 E:\codex\multica\mj-automation\scripts\，
 * 但 playwright 1.62.1 是装在原项目里的：
 *   E:\codex\niannianai\zhuanhuiyuangong\ai-rpa-console\node_modules
 * 原目录是只读的，我们不复制整个 node_modules（几百 MB 且含浏览器驱动），
 * 而是在进程内把原项目的 node_modules 追加为解析路径。
 *
 * 任何 require('playwright') 之类的三方包请求，若本地解析失败，
 * 会自动回落到 MXAI_NODE_MODULES（默认即上述原项目 node_modules）。
 *
 * 这样做不修改任何原文件、不复制依赖，也不影响原项目自身运行。
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

const localNodeModules = path.resolve(__dirname, '..', '..', 'runtime', 'node_modules');
const legacyNodeModules = 'E:/codex/niannianai/zhuanhuiyuangong/ai-rpa-console/node_modules';
const EXTRA_NODE_MODULES =
  process.env.MXAI_NODE_MODULES ||
  (fs.existsSync(localNodeModules) ? localNodeModules : legacyNodeModules);

if (EXTRA_NODE_MODULES && !Module.globalPaths.includes(EXTRA_NODE_MODULES)) {
  Module.globalPaths.push(EXTRA_NODE_MODULES);
}

const isBareRequest = (request) =>
  !request.startsWith('.') &&
  !request.startsWith('/') &&
  !request.startsWith('\\') &&
  !/^[A-Za-z]:[\\/]/.test(request);

if (!Module.__mxaiPatched) {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
    try {
      return originalResolve.call(this, request, parent, isMain, options);
    } catch (error) {
      if (!isBareRequest(request)) throw error;
      const fallback = path.join(EXTRA_NODE_MODULES, request);
      try {
        return originalResolve.call(this, fallback, parent, isMain, options);
      } catch (_) {
        throw error;
      }
    }
  };
  Module.__mxaiPatched = true;
}

module.exports = { EXTRA_NODE_MODULES };
