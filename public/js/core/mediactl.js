/* ============================================================================
   核心 · 方向盘 / 媒体键桥接 (core/mediactl.js)
   ----------------------------------------------------------------------------
   特斯拉车机把方向盘多媒体键与"后台播放"控制路由给**当前活动的媒体源**，
   网页侧唯一的标准通道是 Media Session API。这个模块把它包成简单的 bind()。

   关键事实（来自车主手册 + 实测）
     · 浏览器音频在后台会继续播放，方向盘键控制的是"媒体小卡片"
     · AudioVolume* 这类音量键**不拦截**，交还给车机（否则会和车机音量打架）
     · 没有 bind() 时也会安装监听，便于 keys 诊断页观察原始事件

   重写前 mediactl.js 是独立文件但被三个页面各自"再包一层"，且 next/prev 在
   bili 页被特意留空却没有任何说明。这里统一：能力缺失时明确记 miss。
   ============================================================================ */

import { log } from './log.js';

const KEYMAP = {
  MediaPlayPause:  'toggle',
  MediaPlay:       'play',
  MediaPause:      'pause',
  MediaStop:       'stop',
  MediaTrackNext:  'next',
  MediaFastForward:'next',
  MediaTrackPrevious: 'prev',
  MediaRewind:     'prev',
};

// 这些键只记录、不拦截 —— 音量交给车机，避免双重控制
const PASSTHROUGH = /^AudioVolume/i;

const state = {
  ctrl: null,
  meta: null,
  tally: Object.create(null),
  events: [],
  overlayEl: null,
  installed: false,
};

const MAX_EVENTS = 40;

/* ── 事件派发 ────────────────────────────────────────────────────────────── */

function dispatch(name, arg) {
  state.tally[name] = (state.tally[name] || 0) + 1;
  state.events.push({ t: Date.now(), name, arg });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);

  // 供 keys 诊断页监听
  try {
    window.dispatchEvent(new CustomEvent('mediactl-event', { detail: { name, arg, src: 'api' } }));
  } catch {}

  if (state.overlayEl) renderOverlay();

  const c = state.ctrl;
  if (!c) { log('mediactl', { name, miss: 'no-ctrl' }); return; }

  try {
    switch (name) {
      case 'play':   if (c.play)   return void c.play();   break;
      case 'pause':  if (c.pause)  return void c.pause();  break;
      case 'toggle': if (c.toggle) return void c.toggle();
                     if (c.play && c.pause) {
                       return void ((c.isPlaying && c.isPlaying()) ? c.pause() : c.play());
                     }
                     break;
      case 'stop':   if (c.stop)   return void c.stop();   break;
      case 'next':   if (c.next)   return void c.next();   break;
      case 'prev':   if (c.prev)   return void c.prev();   break;
      case 'seekBy': if (c.seekBy) return void c.seekBy(arg); break;
      case 'seekTo': if (c.seekTo) return void c.seekTo(arg); break;
    }
  } catch (e) {
    log('mediactl-ctrl-error', { name, msg: String(e && e.message) });
    return;
  }
  log('mediactl-miss', name);
}

/* ── 安装 ────────────────────────────────────────────────────────────────── */

function install() {
  if (state.installed) return;
  state.installed = true;

  const ms = navigator.mediaSession;
  if (ms) {
    const handlers = {
      play:          () => dispatch('play'),
      pause:         () => dispatch('pause'),
      stop:          () => dispatch('stop'),
      previoustrack: () => dispatch('prev'),
      nexttrack:     () => dispatch('next'),
      seekbackward:  (d) => dispatch('seekBy', -(d.seekOffset || 10)),
      seekforward:   (d) => dispatch('seekBy', d.seekOffset || 10),
      seekto:        (d) => dispatch('seekTo', d.seekTime),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch {}
    }
  }

  // 兜底：部分实现不发 mediaSession 回调，但会派发键盘媒体键。
  // 用捕获阶段，确保先于页面自身的按键处理拿到事件。
  document.addEventListener('keydown', (e) => {
    if (PASSTHROUGH.test(e.key)) {
      state.tally['pass:' + e.key] = (state.tally['pass:' + e.key] || 0) + 1;
      if (state.overlayEl) renderOverlay();
      return;   // 不 preventDefault，交还车机
    }
    const action = KEYMAP[e.key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    dispatch(action);
  }, true);
}

/* ── 公开 API ────────────────────────────────────────────────────────────── */

export const MediaCtl = {
  /** 绑定页面控制器。只需提供 play/pause，其余可选。 */
  bind(ctrl) {
    install();
    state.ctrl = ctrl || null;
    log('mediactl-bind', ctrl ? Object.keys(ctrl) : null);
  },

  /** 推送媒体元信息到车机小卡片。artwork 是单个 URL。 */
  setMeta(meta) {
    install();
    const m = meta || {};
    const key = [m.title, m.artist, m.album].join('|');
    if (state.meta === key) return;
    state.meta = key;
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = new MediaMetadata({
        title: m.title || '',
        artist: m.artist || '',
        album: m.album || '',
        artwork: m.artwork ? [{ src: m.artwork, sizes: '512x512', type: 'image/png' }] : [],
      });
    } catch (e) {
      log('mediactl-meta-error', String(e && e.message));
    }
  },

  /** 'none' | 'paused' | 'playing' */
  setState(s) {
    install();
    if (!navigator.mediaSession) return;
    try { navigator.mediaSession.playbackState = s; } catch {}
  },

  /** 同步进度（调用很频繁，页面侧应节流到 1 秒一次）。 */
  setPosition(duration, position, rate = 1) {
    if (!navigator.mediaSession || !navigator.mediaSession.setPositionState) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(0, position), duration),
        playbackRate: rate,
      });
    } catch {}
  },

  /** 让 UI 按钮也走同一条派发路径（保证日志一致）。 */
  fire(name, arg) { dispatch(name, arg); },

  /** 生成确定性的封面图（标题哈希 → HSL 渐变 + 首字）。 */
  cover(text) {
    const t = String(text || '?');
    if (coverCache.has(t)) return coverCache.get(t);
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, `hsl(${hue}, 62%, 34%)`);
    grad.addColorStop(1, `hsl(${(hue + 48) % 360}, 58%, 16%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.font = 'bold 220px -apple-system, "PingFang SC", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(t.trim().charAt(0) || '♪', 256, 268);
    const url = c.toDataURL('image/png');
    coverCache.set(t, url);
    return url;
  },

  log: () => state.events.slice(),
  tally: () => ({ ...state.tally }),

  support() {
    return {
      mediaSession: !!navigator.mediaSession,
      metadata: typeof MediaMetadata !== 'undefined',
      setPositionState: !!(navigator.mediaSession && navigator.mediaSession.setPositionState),
      actionHandler: !!(navigator.mediaSession && navigator.mediaSession.setActionHandler),
      ua: navigator.userAgent,
    };
  },

  /** 诊断浮层（?keys=1 自动开启，供 keys 页使用）。 */
  overlay(show) {
    install();
    if (!show) {
      if (state.overlayEl) { state.overlayEl.remove(); state.overlayEl = null; }
      return;
    }
    if (!state.overlayEl) {
      const o = document.createElement('div');
      o.id = 'mediactlOverlay';
      o.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;max-width:420px;'
        + 'background:rgba(0,0,0,.86);border:1px solid #2a3a44;border-radius:10px;'
        + 'padding:10px 12px;font:11px/1.5 ui-monospace,Menlo,monospace;color:#cfe9f2;'
        + 'white-space:pre-wrap;word-break:break-all;pointer-events:none';
      document.body.append(o);
      state.overlayEl = o;
      renderOverlay();
    }
  },
};

const coverCache = new Map();

function renderOverlay() {
  if (!state.overlayEl) return;
  const tally = Object.entries(state.tally)
    .map(([k, v]) => `${k}×${v}`).join('  ') || '(无事件)';
  const tail = state.events.slice(-14)
    .map((e) => `${new Date(e.t).toTimeString().slice(0, 8)} ${e.name}${e.arg !== undefined ? ' ' + JSON.stringify(e.arg) : ''}`)
    .join('\n');
  state.overlayEl.textContent = `MediaCtl 事件统计\n${tally}\n\n最近事件:\n${tail || '(无)'}`;
}

// 即使页面没有 bind，也安装监听（诊断页需要看原始事件）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install);
} else {
  install();
}

if (/[?&]keys=1\b/.test(location.search)) {
  MediaCtl.overlay(true);
}

// 暴露到全局：keys.html / ab.html 等诊断页与内联脚本需要
window.MediaCtl = MediaCtl;
