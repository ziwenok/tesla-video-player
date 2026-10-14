/* ============================================================================
   核心 · 视口缩放补偿 (core/viewport.js)
   ----------------------------------------------------------------------------
   问题
     车机某次固件升级后，浏览器按约 1.53 倍渲染页面（devicePixelRatio ≈ 1.53），
     但 CSS 视口只剩 773x601，而物理屏是 1254x784。页面用固定像素布局
     （侧栏 240px、正文 14px），视口一缩，所有东西又大又挤。

   做法
     html { zoom: 1/dpr }，把 1 CSS px 还原成 1 物理 px（1.53 → 0.65）。

   与旧实现的关键区别（旧 ui-scale.js 的坑）
     旧实现靠运行时改写页面 <style> 文本，把里面的 Nvh/Nvw 改成 calc(Nvh / s)
     来抵消 zoom 对 vh/vw 的缩放。这有三个问题：
       1. 只能处理**内联** <style>，处理不了外部样式表；
       2. 任何在脚本运行之后注入的样式都不会被补偿；
       3. 反复调档要靠快照文本，脆弱。
     新实现干脆不用 vh/vw：布局全部用 flex + height:100% 撑满（见 app.css），
     天然不受 zoom 影响。这个模块只负责设置 zoom 值本身。

   优先级：URL 参数 ?ui= > localStorage > 自动判定
   ============================================================================ */

(function () {
'use strict';

const KEY = 'tp_ui_scale';
const MIN = 0.4, MAX = 1.5, STEP = 0.05;

function readParam() {
  try {
    const m = /[?&]ui=([^&#]*)/.exec(location.search);
    if (!m) return null;
    const v = decodeURIComponent(m[1]).toLowerCase();
    if (v === 'auto' || v === 'off' || v === '') { localStorage.removeItem(KEY); return 'auto'; }
    const n = parseFloat(v);
    if (n >= MIN && n <= MAX) { localStorage.setItem(KEY, String(n)); return n; }
    return null;
  } catch { return null; }
}

function readSaved() {
  try {
    const n = parseFloat(localStorage.getItem(KEY));
    if (n >= MIN && n <= MAX) return n;
  } catch {}
  return null;
}

/**
 * 自动判定：只在"车机把页面放大渲染"时补偿，避免误伤桌面小窗口。
 * 三个条件同时满足才动手：
 *   · 车机浏览器 UA（X11; Linux x86_64）
 *   · 视口明显小于物理屏（screen.width / innerWidth > 1.15）
 *   · dpr > 1.15（页面确实被放大了）
 */
function autoScale() {
  const d = window.devicePixelRatio || 1;
  const iw = window.innerWidth || 0;
  const sw = (window.screen && screen.width) || 0;
  const carLike = /X11;\s*Linux x86_64/i.test(navigator.userAgent || '');
  const shrunk = iw > 0 && sw > 0 && (sw / iw) > 1.15;
  if (carLike && shrunk && d > 1.15) {
    const s = Math.max(MIN, Math.min(1, Math.round((1 / d) * 100) / 100));
    return { s, auto: true, why: `auto dpr=${d} iw=${iw} sw=${sw}` };
  }
  return { s: 1, auto: true, carLike, why: `no-auto carLike=${carLike} dpr=${d} iw=${iw} sw=${sw}` };
}

const param = readParam();
let scale, isAuto = false, why;

if (param === 'auto') {
  const a = autoScale(); scale = a.s; isAuto = true; why = a.why;
} else if (param !== null) {
  scale = param; why = 'param';
} else {
  const saved = readSaved();
  if (saved !== null) { scale = saved; why = 'saved'; }
  else { const a = autoScale(); scale = a.s; isAuto = true; why = a.why; }
}

function apply(v) {
  const de = document.documentElement;
  if (v === 1) { de.style.zoom = ''; de.removeAttribute('data-tp-zoom'); }
  else { de.style.zoom = String(v); de.setAttribute('data-tp-zoom', String(v)); }
  de.style.setProperty('--tp-zoom', String(v));
}

apply(scale);

window.__tpUiScale = scale;
window.__tpUiScaleWhy = why;

/* ── 布局档位：按"补偿后的等效宽度"判定，而不是裸媒体查询 ────────────────
   为什么必须这样做
     车机屏是 1254×784（横屏），但浏览器把它放大渲染，CSS 视口只有 773×601，
     再叠加我们的 zoom 补偿 0.65。

     问题：**CSS zoom 不影响媒体查询**。媒体查询看到的始终是 773px，于是
     `@media (max-width: 860px)` 被误判为"窄屏"，把左右结构折成上下结构 ——
     而车机上实际可用宽度是 773 / 0.65 ≈ 1189px，完全放得下左右布局。

   做法
     由 JS 算出等效宽度 = innerWidth / zoom，写到 <html data-tp-layout>，
     CSS 用属性选择器代替媒体查询。桌面窄窗口与车机都能得到正确结果。
   ──────────────────────────────────────────────────────────────────────── */

var STACK_BELOW = 860;   // 低于此等效宽度才折成上下结构

function applyLayout() {
  var w = (window.innerWidth || 0) / (scale || 1);
  var mode = w < STACK_BELOW ? 'stack' : 'wide';
  var de = document.documentElement;
  if (de.getAttribute('data-tp-layout') !== mode) de.setAttribute('data-tp-layout', mode);
  window.__tpLayout = mode;
  window.__tpLayoutWidth = Math.round(w);
}

applyLayout();

var relayoutT = 0;
window.addEventListener('resize', function () {
  clearTimeout(relayoutT);
  relayoutT = setTimeout(applyLayout, 120);
});

// 调试用：?layout=stack|wide 可强制档位
try {
  var lm = /[?&]layout=(stack|wide)/.exec(location.search);
  if (lm) {
    document.documentElement.setAttribute('data-tp-layout', lm[1]);
    window.__tpLayout = lm[1];
  }
} catch (e) {}

/* ── 屏上调档胶囊（车机上打字不便，给一个免输入的入口） ─────────────────── */

let pill = null, labelEl = null;

function save(v) {
  try {
    if (v === 1 || v === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(v));
  } catch {}
}

function render() {
  if (labelEl) {
    labelEl.textContent = Math.round(scale * 100) + '%';
    labelEl.title = why;
  }
}

function setScale(v, remember) {
  v = Math.max(MIN, Math.min(MAX, Math.round(v * 100) / 100));
  scale = v;
  window.__tpUiScale = v;
  if (remember) save(v);
  apply(v);
  if (typeof applyLayout === 'function') applyLayout();   // 缩放变了，布局档位也要重算
  render();
}

function mkBtn(txt, fn) {
  const b = document.createElement('button');
  b.textContent = txt;
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
  return b;
}

function buildPill() {
  if (pill) return;
  pill = document.createElement('div');
  pill.id = 'tpZoomPill';
  pill.append(
    mkBtn('−', () => setScale(scale - STEP, true)),
    (labelEl = mkBtn('100%', () => {
      save(null);
      const a = autoScale();
      scale = a.s; why = a.why; window.__tpUiScale = scale;
      apply(scale); render();
    })),
    mkBtn('+', () => setScale(scale + STEP, true)),
  );
  labelEl.className = 'tp-zoom-val';
  document.body.append(pill);
  render();
}

function maybePill() {
  if (scale !== 1 || isAuto || /X11;\s*Linux x86_64/i.test(navigator.userAgent || '')) buildPill();
}
if (document.body) maybePill();
else document.addEventListener('DOMContentLoaded', maybePill);

/* ── 屏幕参数上报（每次会话一次，便于定位车机分辨率） ───────────────────── */

try {
  if (!sessionStorage.getItem('tp_screen_reported')) {
    sessionStorage.setItem('tp_screen_reported', '1');
    window.addEventListener('load', () => {
      setTimeout(() => {
        const vv = window.visualViewport;
        fetch('/api/debug-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: location.href,
            ua: navigator.userAgent,
            time: new Date().toISOString(),
            log: [{
              t: Date.now(),
              type: 'screen',
              detail: {
                innerWidth: window.innerWidth, innerHeight: window.innerHeight,
                outerWidth: window.outerWidth, outerHeight: window.outerHeight,
                dpr: window.devicePixelRatio,
                screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
                visualViewport: vv ? [vv.width, vv.height, vv.scale] : null,
                clientW: document.documentElement.clientWidth,
                clientH: document.documentElement.clientHeight,
                uiScale: scale, uiScaleAuto: isAuto, uiScaleWhy: why,
              },
            }],
          }),
        }).catch(() => {});
      }, 1500);
    });
  }
} catch {}
})();
