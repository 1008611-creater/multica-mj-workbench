'use strict';
/**
 * =====================================================================
 * MJ 出图管道 · 离线自检（不需要浏览器、不需要联网、不消耗积分）
 * =====================================================================
 *
 * 作用：用历史上真实产生过的一批文件当夹具，验证「质量闸门」是否真的拦得住垃圾。
 *   夹具分两类：
 *     好文件 —— 必须是高清 PNG，闸门要放行
 *     坏文件 —— 缩略图 webp / loading 占位 GIF / HTML 错误页，闸门必须拦下
 *
 * 为什么需要它：改造前的最大问题是「下载失败还报成功」。
 *   这个自检就是这条修复的回归测试 —— 任何时候改动代码，先跑它。
 *
 * 用法（PowerShell）：
 *   cd E:\codex\multica\mj-automation\scripts
 *   node selftest.js
 *
 * 夹具目录默认指向原项目的历史产物目录（只读，不会被改动）。
 * 想换成别的目录：set MJ_FIXTURE_DIR=...
 *
 * 退出码：0 全部符合预期 / 1 有不符合预期的项
 */

const fs = require('fs');
const path = require('path');
const { inspectFile, describe: describeImg } = require('./verify_result.js');

const FIXTURE_DIR = process.env.MJ_FIXTURE_DIR
  || 'E:/codex/niannianai/zhuanhuiyuangong/ai-rpa-console/.automation/results';

// 期望「放行」的：实测高清母图，5.6–9.3MB / 1792x2688 或 1856x2464
const EXPECT_OK = [
  'M01_1_1.png',
  'M07_1_1.png',
  'M07_南天门_MJ8.2_v1.png',
  'M08_御马监_MJ8.2_v1.png',
  'M03_孙悟空_弼马温态_MJ8.2_v1.png',
  'MJ_01_1_1.png',
  'MJ_CS_1_1.png',
];

// 期望「拦下」的：实测垃圾，含缩略图、占位 GIF、错误页
const EXPECT_BLOCK = [
  'M03_1_1.png',        // 24KB webp 缩略图
  'M03_1_2.png',        // 29KB webp 缩略图
  'MJ_01_1.png',        // 18KB webp 缩略图
  'MJ_01_2.png',        // 31KB webp 缩略图
  'niannian_cine_2.png',// 41KB webp 缩略图
  'MJ_CS_1_2.png',      // 1.1KB HTML 错误页
  'MJ_CS_1_3.png',      // 1.0KB HTML 错误页
  'MJ_CS_1_4.png',      // 1.5KB HTML 错误页
  'MJ_CS_3_1.gif',      // 140KB loading 占位 GIF
  'mood_test_1_1.gif',  // 同上
  'niannian_cine_1.gif',// 同上
];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, wantOk) {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) {
    fail += 1;
    failures.push(`[缺夹具] ${name}`);
    return;
  }
  const info = inspectFile(file);
  const ok = info.ok === wantOk;
  if (ok) {
    pass += 1;
    console.log(`  ${wantOk ? 'PASS' : 'BLOCK'} ${name.padEnd(34)} ${describeImg(info)}`);
  } else {
    fail += 1;
    failures.push(`[判定不符] ${name} 期望 ${wantOk ? '放行' : '拦下'}，实际 ${describeImg(info)}`);
    console.log(`  !!  ${name.padEnd(34)} ${describeImg(info)}  期望=${wantOk ? '放行' : '拦下'}`);
  }
}

console.log('='.repeat(78));
console.log('MJ 出图管道 · 离线自检（质量闸门回归测试）');
console.log('夹具目录: ' + FIXTURE_DIR);
console.log('='.repeat(78));

if (!fs.existsSync(FIXTURE_DIR)) {
  console.error('找不到夹具目录。请设置 MJ_FIXTURE_DIR 指向含有历史产物的目录。');
  process.exit(1);
}

console.log('\n[1/2] 高清母图 —— 闸门必须放行');
for (const n of EXPECT_OK) check(n, true);

console.log('\n[2/2] 垃圾产物 —— 闸门必须拦下');
for (const n of EXPECT_BLOCK) check(n, false);

console.log('\n' + '='.repeat(78));
console.log(`结果：通过 ${pass} 项，不符预期 ${fail} 项`);
if (fail) {
  console.log('\n不符合预期的项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n结论：闸门行为与预期不一致，先不要用它跑真实出图。');
  process.exit(1);
}
console.log('结论：闸门工作正常 —— 高清放行、缩略图/占位图/错误页全部拦下。');
console.log('='.repeat(78));
process.exit(0);
