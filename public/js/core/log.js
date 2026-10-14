/* ============================================================================
   核心 · 遥测与日志 (core/log.js)
   ----------------------------------------------------------------------------
   重写前 player / bili / live 各写一套几乎相同的日志上报（事件数组 + 20s 增量
   POST /api/debug-log + pagehide sendBeacon），三份代码要同步改，DEV.md 里
   明确记录过"并行编辑这几个文件互相覆盖"的事故。现在收敛成一份。

   设计
     · 事件先进内存环形缓冲（上限 400），调试面板实时可见
     · 每 20s 增量上报一次（只在有新事件时）
     · 页面卸载时用 sendBeacon 兜底
     · 全局 error / unhandledrejection 自动记录
   ============================================================================ */

import { el, $ } from './dom.js';

const MAX_EVENTS = 400;
const FLUSH_MS = 20000;
const FLUSH_MIN_EVENTS = 5;
const MAX_FLUSH_EVENTS = 200;

const events = [];
let flushedCount = 0;
let flushTimer = 0;
let panel = null;
let panelBody = null;
let panelShown = false;

/** 记录一条事件。type 用短横线命名，detail 可选。 */
export function log(type, detail) {
  const ev = { t: Date.now(), type, detail: detail === undefined ? null : detail };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  // 控制台也留一份，方便桌面调试
  try { console.log('[tp]', type, detail ?? ''); } catch {}

  if (panelShown) renderPanel();
  return ev;
}

/** 记录一条警告（调试面板里标黄）。 */
export function warn(type, detail) {
  return log(type, detail);
}

/* ── 上报 ────────────────────────────────────────────────────────────────── */

function pendingEvents() {
  return events.slice(flushedCount).slice(0, MAX_FLUSH_EVENTS);
}

async function flush(reason) {
  const batch = pendingEvents();
  if (!batch.length) return;
  try {
    const res = await fetch('/api/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: location.href,
        ua: navigator.userAgent,
        time: new Date().toISOString(),
        reason,
        log: batch,
      }),
    });
    if (res.ok) flushedCount = Math.min(flushedCount + batch.length, events.length);
  } catch {
    // 上报失败不影响主流程；下次再试
  }
}

/** 手动立即上报（调试面板的"发送到服务器"按钮）。 */
export function flushNow(reason = 'manual') {
  return flush(reason);
}

/** 启动定时增量上报 + 卸载兜底。 */
export function startReporting() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (events.length - flushedCount >= FLUSH_MIN_EVENTS) flush('auto');
  }, FLUSH_MS);

  // 页面卸载兜底：sendBeacon 不阻塞卸载，比 fetch 可靠
  const onHide = () => {
    const batch = pendingEvents();
    if (!batch.length) return;
    try {
      navigator.sendBeacon('/api/debug-log', new Blob([JSON.stringify({
        url: location.href,
        ua: navigator.userAgent,
        time: new Date().toISOString(),
        reason: 'pagehide',
        log: batch,
      })], { type: 'application/json' }));
    } catch {}
  };
  window.addEventListener('pagehide', onHide);

  // 全局错误也记进来（重写前这是定位"有声音无画面"的关键手段）
  window.addEventListener('error', (e) => {
    log('window-error', { msg: e.message, src: e.filename, line: e.lineno, col: e.colno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    log('unhandled-rejection', { msg: r && (r.message || String(r)) });
  });
}

/* ── 调试面板 ────────────────────────────────────────────────────────────── */

function levelClass(type) {
  if (/fail|error|timeout|stall|giveup/.test(type)) return 'l-err';
  if (/warn|slow|retry|downgrade|skip/.test(type)) return 'l-warn';
  if (/ok|success|ready|first-frame/.test(type)) return 'l-ok';
  return '';
}

function renderPanel() {
  if (!panelBody) return;
  panelBody.textContent = '';
  for (const ev of events) {
    const time = new Date(ev.t).toTimeString().slice(0, 8);
    const detail = ev.detail === null || ev.detail === undefined
      ? ''
      : ' ' + (typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail));
    panelBody.append(el('div', { class: levelClass(ev.type), text: `${time} ${ev.type}${detail}` }));
  }
  panelBody.scrollTop = panelBody.scrollHeight;
}

/** 创建（但不显示）调试面板。 */
export function buildPanel() {
  if (panel) return panel;

  panelBody = el('div', { class: 'tp-logpanel__body' });
  panel = el('div', { class: 'tp-logpanel', hidden: true, id: 'tpLogPanel' }, [
    el('div', { class: 'tp-logpanel__head' }, [
      el('strong', { text: '诊断日志', style: { fontSize: '13px', color: 'var(--tp-accent)' } }),
      el('span', { class: 'tp-grow' }),
      el('button', { class: 'tp-btn', text: '发送到服务器', onClick: () => flushNow('manual') }),
      el('button', { class: 'tp-btn', text: '清空', onClick: () => { events.length = 0; flushedCount = 0; renderPanel(); } }),
      el('button', { class: 'tp-btn', text: '关闭', onClick: () => togglePanel(false) }),
    ]),
    panelBody,
  ]);
  document.body.append(panel);
  renderPanel();
  return panel;
}

/** 显示/隐藏调试面板。 */
export function togglePanel(force) {
  buildPanel();
  panelShown = force === undefined ? !panelShown : !!force;
  panel.hidden = !panelShown;
  if (panelShown) renderPanel();
  return panelShown;
}

export function isPanelShown() { return panelShown; }

/**
 * 给页面绑定调试入口：
 *   · URL 带 ?log=1 时直接展开
 *   · 按 L 键切换
 *   · 若页面已有 [data-tp-log-toggle] 元素则点击也能切换
 */
export function bindPanel() {
  buildPanel();

  if (/[?&]log=1\b/.test(location.search)) togglePanel(true);

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'l' || e.key === 'L') { togglePanel(); }
  });

  const btn = document.querySelector('[data-tp-log-toggle]');
  if (btn) btn.addEventListener('click', () => togglePanel());
}
