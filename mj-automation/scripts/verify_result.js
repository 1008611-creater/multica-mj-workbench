'use strict';
/**
 * 产物校验模块（MJ 出图质量闸门）
 *
 * 背景：改造前下载失败会静默降级成页面缩略图，甚至把 140KB 的 loading 占位图、
 * 1KB 的错误页当成产物，对外仍然返回 success:true。这个模块是唯一的判定入口，
 * 任何写盘后的文件都必须先过这里，才算“可用高清原图”。
 *
 * 判定顺序：魔数 → 格式白名单 → 字节下限 → 尺寸下限 → 内容黑名单
 * 只做本地校验，不联网、不猜。
 */

const fs = require('fs');
const crypto = require('crypto');

// 默认闸门：低于这些值的文件一律不算高清原图
const DEFAULTS = {
  minBytes: 200 * 1024, // 200KB：MJ v8.2 高清原图实测 5.6–9.3MB，缩略图/占位图远低于此
  minW: 1024,
  minH: 1024,
};

const MAGIC = {
  png: '89504e470d0a1a0a',
  jpeg: 'ffd8ff',
  gif: '474946383', // GIF87a / GIF89a 前 9 位
  webp: '52494646', // RIFF，需再看 8..12 == WEBP
  bmp: '424d',
};

function detectFormat(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  const head = buf.toString('hex', 0, 12).toLowerCase();
  if (head.startsWith(MAGIC.png)) return 'png';
  if (head.startsWith(MAGIC.jpeg)) return 'jpeg';
  if (head.startsWith(MAGIC.gif)) return 'gif';
  if (head.startsWith(MAGIC.webp) && buf.toString('hex', 8, 12).toLowerCase() === '57454250') return 'webp';
  if (head.startsWith(MAGIC.bmp)) return 'bmp';
  // HTML 错误页 / JSON 报错
  const text = buf.toString('utf8', 0, Math.min(buf.length, 200)).trim().toLowerCase();
  if (text.startsWith('<') || text.startsWith('{') || text.startsWith('<!doctype')) return 'text';
  return 'unknown';
}

function dimOf(buf) {
  if (!buf) return { w: 0, h: 0 };
  const fmt = detectFormat(buf);
  try {
    if (fmt === 'png' && buf.length > 24) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (fmt === 'jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len <= 0) break;
        i += 2 + len;
      }
    }
    if (fmt === 'webp' && buf.length > 30) {
      const variant = buf.toString('hex', 12, 16).toLowerCase();
      if (variant === '56503820') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (variant === '5650384c') {
        const bits = buf.readUInt32LE(21);
        return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (variant === '56503858') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (fmt === 'gif' && buf.length > 10) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
  } catch (e) { /* 结构异常按 0x0 处理 */ }
  return { w: 0, h: 0 };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * 校验一段内存中的图片数据。
 * @returns {{ok:boolean, format:string, w:number, h:number, bytes:number, sha256:string, reason:string, verdict:string}}
 */
function inspectBuffer(buf, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const bytes = buf ? buf.length : 0;
  const format = detectFormat(buf);
  const dim = dimOf(buf);
  const hash = buf ? sha256(buf) : '';
  const base = { format, w: dim.w, h: dim.h, bytes, sha256: hash };

  if (!buf || !bytes) return { ...base, ok: false, reason: '空文件', verdict: 'EMPTY' };
  if (format === 'gif') return { ...base, ok: false, reason: 'GIF 占位图（MJ 不产出 GIF）', verdict: 'PLACEHOLDER_GIF' };
  if (format === 'text') return { ...base, ok: false, reason: '内容是 HTML/JSON，不是图片', verdict: 'NOT_IMAGE' };
  if (format === 'unknown' || format === 'bmp') return { ...base, ok: false, reason: '不是受支持的图片格式', verdict: 'BAD_FORMAT' };
  if (bytes < opt.minBytes) return { ...base, ok: false, reason: `字节数 ${bytes} 低于下限 ${opt.minBytes}`, verdict: 'TOO_SMALL_BYTES' };
  if (dim.w < opt.minW || dim.h < opt.minH) {
    return { ...base, ok: false, reason: `尺寸 ${dim.w}x${dim.h} 低于下限 ${opt.minW}x${opt.minH}`, verdict: 'TOO_SMALL_DIM' };
  }
  return { ...base, ok: true, reason: '', verdict: 'OK_HD' };
}

function inspectFile(file, options = {}) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, file, format: 'unknown', w: 0, h: 0, bytes: 0, sha256: '', reason: `读不到文件：${e.message}`, verdict: 'UNREADABLE' };
  }
  return { file, ...inspectBuffer(buf, options) };
}

function isUsableImage(file, options = {}) {
  return inspectFile(file, options).ok;
}

/** 人类可读的一行日志 */
function describe(info) {
  return `${info.verdict} ${info.w}x${info.h} ${info.bytes}B sha=${info.sha256}${info.reason ? ' :: ' + info.reason : ''}`;
}

module.exports = { DEFAULTS, detectFormat, dimOf, sha256, inspectBuffer, inspectFile, isUsableImage, describe };
