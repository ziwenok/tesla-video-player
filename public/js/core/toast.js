/* ============================================================================
   核心 · 通知 (core/toast.js)
   ----------------------------------------------------------------------------
   重写前用 alert()/confirm() 提示（B站页登录未登录、清理进程等），
   在车机上 alert 会阻塞整个页面且样式无法控制。这里换成轻量 toast。
   confirm 场景用 toast 代替不了，保留一个轻量确认框。
   ============================================================================ */

import { el } from './dom.js';

let host = null;

function ensureHost() {
  if (host) return host;
  host = el('div', { id: 'tpToasts' });
  document.body.append(host);
  return host;
}

/**
 * 弹一条提示。
 * @param {string} msg
 * @param {'info'|'ok'|'warn'|'danger'} kind
 * @param {number} ms 显示时长
 */
export function toast(msg, kind = 'info', ms = 2600) {
  ensureHost();
  const cls = kind === 'info' ? 'tp-toast' : `tp-toast tp-toast--${kind}`;
  const node = el('div', { class: cls, text: msg });
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

export const toastOk     = (m, ms) => toast(m, 'ok', ms);
export const toastWarn   = (m, ms) => toast(m, 'warn', ms);
export const toastDanger = (m, ms) => toast(m, 'danger', ms);

/**
 * 轻量确认框（替代 confirm）。
 * @returns {Promise<boolean>}
 */
export function confirmBox(message, { okText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const close = (v) => {
      box.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    };

    const box = el('div', { class: 'tp-modal' }, [
      el('div', { class: 'tp-modal__box' }, [
        el('div', { text: message, style: { fontSize: 'var(--tp-fs-md)', lineHeight: '1.5' } }),
        el('div', { class: 'tp-row', style: { justifyContent: 'center', gap: '12px' } }, [
          el('button', { class: 'tp-btn', text: cancelText, onClick: () => close(false) }),
          el('button', {
            class: danger ? 'tp-btn tp-btn--danger' : 'tp-btn tp-btn--primary',
            text: okText,
            onClick: () => close(true),
          }),
        ]),
      ]),
    ]);
    box.addEventListener('click', (e) => { if (e.target === box) close(false); });
    document.addEventListener('keydown', onKey);
    document.body.append(box);
  });
}
