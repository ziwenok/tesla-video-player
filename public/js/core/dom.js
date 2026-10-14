/* ============================================================================
   核心 · DOM 与格式化工具 (core/dom.js)
   ----------------------------------------------------------------------------
   重写前每个页面都手写一遍 el()/esc()/fmtSize()/fmtTime()，且 B站页、音乐页
   直接把服务端数据拼进 innerHTML（标题里一个 & 或 < 就会破版，也是 XSS 面）。
   这里统一提供"安全"的 DOM 构建方式：默认走 textContent，不用 innerHTML。
   ============================================================================ */

/** 建元素。attrs 里的 text 走 textContent(安全)；html 才走 innerHTML(慎用)。 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);       // 仅用于可信内容
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      // 必须转小写：addEventListener 的事件名是大小写敏感的，
      // 'onClick'.slice(2) === 'Click' 不会触发任何事件。
      node.addEventListener(k.slice(2).toLowerCase(), v);
    }
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') node[k] = !!v;
    else node.setAttribute(k, String(v));
  }

  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 转义为可安全放进 innerHTML 的文本（少数必须用 HTML 的地方）。 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 清空子节点。 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 替换全部子节点。 */
export function replace(node, children) {
  clear(node);
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ── 格式化 ──────────────────────────────────────────────────────────────── */

/** 字节 → 人类可读。 */
export function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

/** 秒 → m:ss / h:mm:ss。 */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** 数字 → 中文万/亿单位。 */
export function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v);
}

/** 从文件名去掉扩展名与开头的 "01 - " 序号。 */
export function cleanName(name) {
  return String(name ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+\s*-\s*/, '')
    .replace(/[_]+/g, ' ')
    .trim();
}

/**
 * 从音乐文件名拆出 {artist, title}。
 *
 * 本音乐库的命名约定是「序号 - 歌名-歌手」，例如：
 *   "01 - 平凡之路-朴树.mp3"   → title=平凡之路  artist=朴树
 *   "05 - traveling light.mp3" → title=traveling light  artist=本机音乐
 * 即：去掉序号前缀后，**最后一个**连字符分隔"歌名"与"歌手"。
 *
 * 注意不要按第一个连字符切：那样会得到 artist="平凡之路"、title="朴树"（反的）。
 */
export function splitArtist(name) {
  const base = cleanName(name);
  // 用最后一个连字符切分（歌名里本身可能含连字符）
  const idx = Math.max(base.lastIndexOf('-'), base.lastIndexOf('–'), base.lastIndexOf('—'));
  if (idx > 0) {
    const title = base.slice(0, idx).trim();
    const artist = base.slice(idx + 1).trim();
    if (title && artist) return { artist, title };
  }
  return { artist: '本机音乐', title: base };
}

/** 防抖。 */
export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** 节流（尾部保证触发一次）。 */
export function throttle(fn, ms) {
  let last = 0, timer = 0, lastArgs = null;
  return (...a) => {
    const now = Date.now();
    lastArgs = a;
    if (now - last >= ms) { last = now; fn(...a); }
    else if (!timer) {
      timer = setTimeout(() => { timer = 0; last = Date.now(); fn(...lastArgs); }, ms - (now - last));
    }
  };
}

/** 睡眠。 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 predicate 为真或超时。返回是否成功。 */
export async function waitFor(predicate, { interval = 2000, timeout = 60000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

/** 取整到偶数（yuv420p 要求宽高都能被 2 整除，奇数尺寸会让 ffmpeg 输出 0 字节）。 */
export const even = (n) => { const v = Math.max(2, Math.round(n)); return v - (v % 2); };

/** 夹取。 */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
