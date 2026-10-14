/* ============================================================================
   核心 · 音频主时钟 (core/clock.js)
   ----------------------------------------------------------------------------
   为什么需要它
     车机上音视频是两条独立链路（<audio> 直接播，画面走帧流/解码）。两边各有
     自己的挂钟，跑久了必然漂移。重写前 player / bili / live 三个页面各自
     实现了一遍"音频是主时钟 + 停摆兜底 + 恢复可见时重同步"，三份逻辑还都不
     完全一样（WebCodecs 那份的补偿符号甚至是反的，等于把用户的音画校准反转）。

   本模块提供
     · 以 audio.currentTime 为唯一基准的 position()
     · 音频停摆检测（currentTime 3 秒不前进 → 退化为挂钟，避免画面永久卡死）
     · 恢复可见 / seek 后重同步
     · 节流的进度回调（给车机媒体系统同步用）

   注意：本模块不负责播放音频，只负责"现在是第几秒"这件事。
   ============================================================================ */

import { log } from './log.js';

export class AudioClock {
  /**
   * @param {HTMLAudioElement} audio
   * @param {object} [opts]
   *   onTick(sec)      每帧推进时回调（节流）
   *   stallMs          判定停摆的时长，默认 3000
   */
  constructor(audio, opts = {}) {
    this.audio = audio;
    this.opts = opts;
    this.stallMs = opts.stallMs ?? 3000;

    this.lastPos = -1;
    this.lastPosAt = Date.now();
    this.stalled = false;
    this.usingWall = false;
    this.wallBase = 0;
    this.wallAt = 0;

    this._onVisible = () => {
      if (document.visibilityState === 'visible') this.resync();
    };
  }

  attach() {
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('focus', this._onVisible);
    window.addEventListener('pageshow', this._onVisible);
    return this;
  }

  detach() {
    document.removeEventListener('visibilitychange', this._onVisible);
    window.removeEventListener('focus', this._onVisible);
    window.removeEventListener('pageshow', this._onVisible);
  }

  /** 音频当前播放位置（秒）。音频未就绪返回 null。 */
  raw() {
    const a = this.audio;
    if (!a) return null;
    if (!Number.isFinite(a.currentTime)) return null;
    return a.currentTime;
  }

  /** 时长（秒）。 */
  duration() {
    const a = this.audio;
    if (a && Number.isFinite(a.duration) && a.duration > 0) return a.duration;
    return this.fallbackDuration ?? 0;
  }

  /** 供无音频时长时（如直播）由外部注入总长。 */
  setDuration(d) { this.fallbackDuration = d; }

  /**
   * 主时钟位置（秒）。
   * 音频在推进就用音频；停摆超过 stallMs 就退化为挂钟，避免画面永久卡死。
   */
  position() {
    const a = this.audio;
    const now = Date.now();
    const p = this.raw();

    if (p === null) return null;

    // 检测音频是否真的在推进
    if (p !== this.lastPos) {
      this.lastPos = p;
      this.lastPosAt = now;
      if (this.stalled) {
        log('audio-clock-recovered', p.toFixed(2));
        this.stalled = false;
      }
      this.usingWall = false;
      this.wallBase = p;
      this.wallAt = now;
      return p;
    }

    // 位置没变：可能是暂停，也可能是"在播但时钟不走"
    if (a && a.paused) return p;

    if (now - this.lastPosAt > this.stallMs) {
      if (!this.stalled) {
        log('audio-clock-stall', { pos: p.toFixed(2), ms: now - this.lastPosAt });
        this.stalled = true;
        this.usingWall = true;
        this.wallBase = p;
        this.wallAt = now;
      }
      // 退化：按挂钟外推，保证画面继续出
      return this.wallBase + (now - this.wallAt) / 1000;
    }

    return p;
  }

  /** 恢复可见 / seek 后重新对齐（丢掉停摆期间的挂钟外推）。 */
  resync() {
    const p = this.raw();
    if (p === null) return;
    this.lastPos = p;
    this.lastPosAt = Date.now();
    this.stalled = false;
    this.usingWall = false;
    this.wallBase = p;
    this.wallAt = Date.now();
    if (this.opts.onResync) this.opts.onResync(p);
  }

  /** 音频就绪（能拿到时长且已加载元数据）。 */
  ready() {
    const a = this.audio;
    return !!(a && a.readyState >= 1);
  }

  /** 等待音频就绪。返回是否成功。 */
  async waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.ready()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * 监听音频异常（ended / error / 长时间不出声），交给页面处理重连。
   * 注意：暂停状态下不得判死（用户主动暂停不是故障）。
   */
  watch({ onFail, neverStartedMs = 12000 } = {}) {
    const a = this.audio;
    if (!a) return () => {};

    let started = false;
    let lastT = -1;
    const t0 = Date.now();

    const onPlay = () => { started = true; };
    const onEnded = () => { if (onFail) onFail('ended'); };
    const onErr = () => { if (onFail) onFail('error'); };

    a.addEventListener('playing', onPlay);
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onErr);

    const iv = setInterval(() => {
      // 暂停中不判死
      if (a.paused) return;
      // 已经在播且时钟在走 = 健康
      if (started && a.currentTime !== lastT) { lastT = a.currentTime; return; }
      if (started && a.readyState >= 2) return;   // 有数据，只是暂时不推进
      // 从未开始播且超时
      if (!started && Date.now() - t0 > neverStartedMs) {
        if (onFail) onFail('never-started');
      }
    }, 2000);

    return () => {
      a.removeEventListener('playing', onPlay);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onErr);
      clearInterval(iv);
    };
  }
}
