/* ============================================================================
   核心 · D 档帧流播放内核 (core/frames.js)
   ----------------------------------------------------------------------------
   这是整个系统最关键的一块。重写前它的逻辑被复制了三份：
     player.html 的 WSFrameEngine、bili.html 的帧流分支、live.html 的帧流分支。
   三份各自演进，坑也是各踩一遍。现在只此一份。

   为什么需要它（特斯拉车机的 D 档限制）
     特斯拉在 D/R/N 档会冻结 <video> 的画面（音频不受影响）。因此：
       · 画面不能靠 <video> 显示 —— 服务端用 ffmpeg 把视频转成 JPEG 帧流，
         经 WebSocket 推给浏览器，浏览器解码后 drawImage 到 <canvas>。
       · 音频单独走 <audio>（音频不会被冻结）。
       · 声音是听感基准：画面跟随音频时钟，而不是两边各走各的挂钟。

   协议（服务端 server.js /ws/frames）
     二进制帧 = 4 字节小端 uint32 内容位置(毫秒) + 完整 JPEG(FFD8...FFD9)
     文本帧 = JSON 控制/状态信息，如 {"type":"src",ch,idx,src,total}
     客户端→服务端 = {"type":"pause"|"resume"} 控制服务端推流泵速

   以下每一条都是实测踩出来的，改动前先读注释：
     1. createImageBitmap 在车机 QtWebEngine 上可能永不 resolve/reject
        → 画面永久冻结。必须带看门狗，超时后本实例强制改走 Image 解码。
     2. 用 Image + createObjectURL 时必须在 onload 和 onerror 都 revokeObjectURL，
        否则每帧泄漏一个 blob URL 及其底层数据（15fps 下约 40MB/分钟）。
     3. 重连时不要清空帧缓冲：保留 seek 之前的旧帧盖住重连空窗，防黑屏跳变。
     4. 时间戳必须用服务端逐帧给的内容位置，不能用本地 +1/fps 计数
        （否则拖动进度条后画面会快进）。
     5. 帧缓冲上限必须加在"数据入口"侧，不能放在渲染循环里
        —— 页面隐藏时 rAF 被挂起，只进不出会内存无界增长。
     6. 旧写法在渲染循环内部自我重调度：页面被报告 hidden 后浏览器挂起 rAF，
        之后没有任何回调会再调度它 → 画面永久停摆（有声音无画面）。
        必须：可被外部重启 + 看门狗兜底 + 恢复可见时主动重启。
     7. 服务端泵速控制（缓冲满→pause，缓冲低→resume）要带迟滞，防抖。
     8. 一帧都没出就断开 = 这个档位在当前链路上出不了画面，用同一档位重连
        只会无限循环（实测卡死十几分钟不恢复），必须回退一档。
   ============================================================================ */

import { el, clamp } from './dom.js';
import { log } from './log.js';

/** 画面停摆多久算卡死（音频在推进的前提下）。可用 opts.stallMs 覆盖。 */
const STALL_MS = 12000;
/** 连续自愈多少次仍无效就降档。 */
const STALL_MAX_RELOADS = 3;
/**
 * 帧缓冲允许落后音频多少秒。
 * 超过就认为需要重新对齐（而不是把缓冲清空）—— 见 _render 里的说明。
 * 取值要大于正常抖动（约 1~2s），又要能及时触发对齐。
 */
const LAG_TOLERANCE = 4;

/** 服务端给的 4 字节小端时间戳(ms) → 秒。裸 JPEG 旧帧返回 null。 */
function parseStamp(u8) {
  if (u8.length > 6 && u8[4] === 0xFF && u8[5] === 0xD8) {
    return (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) / 1000;
  }
  return null;
}

export class FrameStream {
  /**
   * @param {object} opts
   *   canvas     {HTMLCanvasElement} 绘制目标
   *   audio      {HTMLAudioElement}  音频（主时钟）
   *   url        {string}  ws(s)://... 基础地址（不含 query）
   *   query      {object}  查询参数（file/fps/w/h/q/seek/loop/live/bili）
   *   syncLag    {number}  音画补偿秒（画面比声音慢 L 秒）
   *   onStats    {function} 统计回调
   *   onSrcInfo  {function} 服务端 src/srcfail 文本帧回调
   *   onEnded    {function} 服务端关闭且不再重连
   */
  constructor(opts) {
    this.o = opts;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.audio = opts.audio;
    this.syncLag = opts.syncLag ?? 0.12;
    /**
     * 是否自己维护渲染循环。
     * 播放器统一用一个循环驱动所有引擎（见 player.html 的 tick）时传 false ——
     * 这样"rAF 被挂起后画面永久停摆"的兜底只有一处，不会三个引擎各修一遍。
     */
    this.ownLoop = opts.ownLoop !== false;
    /**
     * 停摆判定阈值（毫秒）。默认 12s，适合本地/B站（首帧快）。
     * YouTube 走 yt-dlp 管道取流，首帧常要 10~30s，需要放宽，
     * 否则会把"正常慢启动"误判为卡死并触发无谓的重连。
     */
    this.stallMs = opts.stallMs || STALL_MS;

    /* ── 缓冲：存原始 JPEG 字节，呈现时才解码（省内存） ── */
    this.buffer = [];               // [{data:Uint8Array, t:number}]
    this.MAX_FRAMES = 240;          // 硬上限（约 45MB/分钟）

    /* ── 播放状态 ── */
    this.ws = null;
    this.running = false;
    this.destroyed = false;
    this.gen = 0;                   // 代际：换源/重连后旧回调必须失效
    this.reconnectT = 0;
    this.connectedAt = 0;
    this.connFrames = 0;
    this.totalFrames = 0;
    this.badStreak = 0;
    this.qualityIdx = opts.qualityIdx ?? 0;
    this.qualities = opts.qualities ?? null;

    /* ── 渲染 ── */
    this.rafId = 0;
    this.rafAt = 0;
    this.rafWatch = 0;
    this.fallbackIv = 0;
    this.drawn = 0;
    this.dropped = 0;

    /* ── 音频未就绪时的挂钟兜底 ── */
    this._wallBase = null;

    /* ── 解码 ── */
    this.decBusy = false;
    this.decLastT = -1;
    this.decStart = 0;
    this.forceImg = false;          // 看门狗超时后强制走 Image 解码
    this.useBmp = typeof createImageBitmap !== 'undefined';

    /* ── 服务端泵速 ── */
    this.paused = false;
    this.pumpPaused = false;

    /* ── 帧率统计 ── */
    this.stats = { t0: Date.now(), frames: 0, low: 0, advanced: 0 };

    /* ── 兜底计时器 ── */
    this.pumpIv = 0;
    this.statIv = 0;

    this._onVisible = () => {
      if (document.visibilityState === 'visible') {
        this.dropStale();
        this.startLoop();
      }
    };
  }

  /* ======================================================================
     生命周期
     ====================================================================== */

  start(seek = 0) {
    if (this.destroyed) return;
    this.stop(true);
    this.running = true;
    this.gen++;
    this._connect(seek);
    if (this.ownLoop) this.startLoop();
    this._startPump();
    this._startStats();
  }

  stop(keepBuffer = false) {
    this.running = false;
    this.gen++;
    clearTimeout(this.reconnectT);
    if (this.ws) {
      try {
        this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    if (!keepBuffer) this.buffer.length = 0;
    this.stopLoop();
    clearInterval(this.pumpIv); this.pumpIv = 0;
    clearInterval(this.statIv); this.statIv = 0;
    document.removeEventListener('visibilitychange', this._onVisible);
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.buffer.length = 0;
  }

  /**
   * 当前播放到的内容位置（秒）。
   *
   * 正常情况：音频是主时钟（听感基准，画面跟随声音）。
   *
   * 但音频可能尚未就绪（YouTube 上 yt-dlp 取流要十几秒，而画面先到）。
   * 此时若返回 null，_render 会直接 return → 画面永远不画 → 页面等不到首帧
   * 就不起播音频 → **死锁**。
   *
   * 因此音频未就绪时回退到"挂钟"：以首帧到达时刻为 0，按真实时间推进。
   * 这样画面能先出，音频就绪后自动切回音频时钟（posMs 优先用音频）。
   */
  posMs() {
    const a = this.audio;
    if (a && !a.paused && a.readyState >= 1 && Number.isFinite(a.currentTime)) {
      this._wallBase = null;            // 音频接管，清掉挂钟基准
      return a.currentTime;
    }
    // 音频未就绪：用挂钟兜底（仅当已有帧时才用，避免空转）
    if (!this.buffer.length) return null;
    if (this._wallBase == null) this._wallBase = Date.now();
    return (Date.now() - this._wallBase) / 1000;
  }

  /* ======================================================================
     WebSocket
     ====================================================================== */

  _wsUrl(seek) {
    const { url, query = {} } = this.o;
    const q = { ...query };
    if (seek !== undefined && seek !== null) q.seek = seek.toFixed(3);
    const qs = Object.entries(q)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return qs ? `${url}?${qs}` : url;
  }

  _connect(seek) {
    const gen = this.gen;
    let ws;
    try {
      ws = new WebSocket(this._wsUrl(seek));
    } catch (e) {
      log('ws-connect-throw', String(e && e.message));
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.connectedAt = Date.now();
      this.connFrames = 0;
      log('ws-open', this.o.label || '');
    };

    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;

      // 文本帧：控制/状态
      if (typeof ev.data === 'string') {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch {}
        if (msg && this.o.onSrcInfo) this.o.onSrcInfo(msg);
        return;
      }

      const u8 = new Uint8Array(ev.data);
      let t = parseStamp(u8);
      let data;
      if (t === null) {
        // 兼容裸 JPEG 旧帧：按序计数
        data = u8;
        t = this._seqT = (this._seqT ?? 0);
        this._seqT += 1 / (this.o.query?.fps || 15);
      } else {
        data = u8.subarray(4);
      }

      if (this.connFrames === 0) log('ws-first-frame', this.o.label || '');
      this.connFrames++;
      this.totalFrames++;
      this.badStreak = 0;

      this.buffer.push({ data, t });
      // 硬上限加在入口侧：页面隐藏时渲染循环停摆，只进不出会内存暴涨
      while (this.buffer.length > this.MAX_FRAMES) {
        this.buffer.shift();
        this.dropped++;
      }
    };

    ws.onclose = (ev) => {
      if (gen !== this.gen) return;
      log('ws-close', { code: ev.code, frames: this.connFrames });
      if (this.o.onClose) this.o.onClose(ev, this.connFrames);
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      if (gen !== this.gen) return;
      log('ws-error', this.o.label || '');
    };
  }

  _scheduleReconnect() {
    if (!this.running || this.destroyed) return;

    // 一帧都没出就断 = 这个档位在当前链路上出不了画面。
    // 用同一档位重连只会无限循环（实测卡死十几分钟不恢复），所以回退一档。
    if (this.connFrames === 0) {
      this.badStreak++;
      if (this.qualities && this.qualityIdx > 0) {
        this.qualityIdx--;
        log('ws-quality-backoff', { qIdx: this.qualityIdx, streak: this.badStreak });
        if (this.o.onQualityChange) this.o.onQualityChange(this.qualityIdx);
      }
    }

    const wait = (this.qualityIdx === 0 && this.badStreak >= 2) ? 8000 : 2500;
    clearTimeout(this.reconnectT);
    this.reconnectT = setTimeout(() => {
      if (!this.running || this.destroyed) return;
      const pos = this.posMs() ?? 0;
      log('ws-reconnect', { wait, pos: pos.toFixed(1) });
      this.gen++;
      this._connect(pos);
    }, wait);
  }

  /* ======================================================================
     服务端泵速控制（缓冲满→暂停，缓冲低→恢复，带迟滞防抖）
     ====================================================================== */

  _startPump() {
    this.PUMP = { TARGET: 60, MIN: 8, RESUME_GAP: 20 };
    clearInterval(this.pumpIv);
    this.pumpIv = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const pos = this.posMs();
      const cushion = pos === null ? 0 : this._bufferedAhead(pos);

      if (!this.pumpPaused && cushion > this.PUMP.TARGET) {
        this._sendCtrl('pause');
        this.pumpPaused = true;
        log('pump-pause', cushion.toFixed(1));
      } else if (this.pumpPaused && cushion < this.PUMP.TARGET - this.PUMP.RESUME_GAP) {
        this._sendCtrl('resume');
        this.pumpPaused = false;
        log('pump-resume', cushion.toFixed(1));
      }
    }, 1000);
  }

  _sendCtrl(type) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type }));
    } catch {}
  }

  /** 播放位置前方已缓冲的秒数。 */
  _bufferedAhead(pos) {
    let last = -Infinity;
    for (const f of this.buffer) if (f.t > last) last = f.t;
    return last === -Infinity ? 0 : Math.max(0, last - pos);
  }

  /* ======================================================================
     渲染循环（可被外部重启 + 看门狗 + 可见性恢复）
     ====================================================================== */

  startLoop() {
    if (this.rafId || this.destroyed) return;
    this.rafAt = Date.now();
    this._scheduleRaf();

    // 看门狗：rAF 超过 1.5s 没回调就强制重启
    clearInterval(this.rafWatch);
    this.rafWatch = setInterval(() => {
      if (this.destroyed || !this.running) return;
      if (Date.now() - this.rafAt > 1500) {
        log('raf-watchdog-restart');
        this.rafId = 0;
        this._scheduleRaf();
      }
    }, 1000);

    // 兜底：即使 rAF 完全不可用也保持低频出画（页面隐藏时会被浏览器钳制到 1s）
    clearInterval(this.fallbackIv);
    this.fallbackIv = setInterval(() => { this._render(); }, 400);

    document.addEventListener('visibilitychange', this._onVisible);
  }

  stopLoop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    clearInterval(this.rafWatch); this.rafWatch = 0;
    clearInterval(this.fallbackIv); this.fallbackIv = 0;
  }

  _scheduleRaf() {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.rafAt = Date.now();
      this._render();
      if (this.running) this._scheduleRaf();
    });
  }

  /** 丢掉已经播过的旧帧（页面恢复可见 / seek 后调用）。 */
  dropStale() {
    const pos = this.posMs();
    if (pos === null) return;
    const cut = pos - this.syncLag - 2;
    while (this.buffer.length && this.buffer[0].t < cut) this.buffer.shift();
  }

  /**
   * 呈现一帧。外部循环驱动时直接调用它（ownLoop:false）。
   * @param {number} [posSec] 主时钟位置；不传则用音频自身
   */
  render(posSec) {
    this._render(posSec);
  }

  _render(posSec) {
    const pos = posSec !== undefined ? posSec : this.posMs();
    if (pos === null) return;              // 音频未就绪：等它，画面不抢跑
    const target = pos - this.syncLag + 0.15;

    /* 落后检测（YouTube 等"音频先跑、画面后到"的场景必需）
       帧流可能整体落后于音频位置（例如 YouTube 要等 yt-dlp 取流十几秒，
       而帧从 0 开始推）。此时若照常"清掉 2 秒前的帧"，会把缓冲全部清空，
       于是永远选不出可呈现的帧 → 有声音无画面。

       处理：先判断缓冲里最新的帧是否明显落后于目标位置。
       是 → 上报需要重新对齐（页面据此 seek），并**保留**缓冲不清空，
            避免把仅有的帧也丢掉。 */
    if (this.buffer.length) {
      const oldest = this.buffer[0].t;
      const newest = this.buffer[this.buffer.length - 1].t;

      // 情况一：画面整体**落后**于音频（帧还没追上播放位置）
      if (target - newest > LAG_TOLERANCE) {
        this.lagging = true;
        if (this.o.onLagging) {
          try { this.o.onLagging({ target, newest, lag: target - newest }); } catch {}
        }
        return;                            // 等页面触发对齐，别清缓冲
      }

      /* 情况二：画面整体**超前**于音频（缓冲里最早的帧都比播放位置新）
         这在 YouTube 上很常见：ffmpeg 会预解码一段，而音频才刚开始。
         此时 target 落在所有帧之前，下面选不出帧 → 永远不渲染。
         处理：把 target 提升到缓冲最早帧（"用现有最新可用画面先出画"），
         画面会短暂超前，但随音频推进很快自然对齐，不会卡死。 */
      if (oldest > target + LAG_TOLERANCE) {
        this.leading = true;
        this._forceTarget = oldest;
      } else {
        this.leading = false;
        this._forceTarget = 0;
      }
      this.lagging = false;
    }

    // 清理：已播完 2 秒前的帧
    const cut = pos - this.syncLag - 2;
    while (this.buffer.length && this.buffer[0].t < cut) {
      this.buffer.shift();
      this.dropped++;
    }

    // 画面超前时用"最早帧"作为目标，保证能出画（见上面的说明）
    const effTarget = this._forceTarget || target;

    // 选 t <= effTarget 的最新帧（中间的丢帧不压缩时间轴）
    let present = null;
    for (const f of this.buffer) {
      if (f.t <= effTarget) { if (!present || f.t > present.t) present = f; }
      else break;
    }
    if (!present) return;
    if (present.t === this.decLastT) return;   // 已画过
    if (this.decBusy) return;

    // 按需解码
    this._decode(present);
  }

  _decode(frame) {
    this.decBusy = true;
    this.decStart = Date.now();
    // 注意：这里**不能**提前写 decLastT。
    // 曾经的严重 bug：解码开始前就把 decLastT 设成该帧时间戳，而 _render()
    // 用 `present.t === decLastT` 判断"已画过"直接 return。于是只要有一帧
    // 解码失败/超时（车机上 createImageBitmap 偶发挂起），这一帧就被永久
    // 标记为"已画"，后续每次渲染都跳过它 → 画面永久卡死、声音正常。
    // 实测表现就是"播到 10 分钟左右画面卡住"。必须只在解码成功后标记。

    const done = (bmp) => {
      this.decBusy = false;
      if (this.destroyed) { if (bmp && bmp.close) bmp.close(); return; }
      // 成功才认账
      this.decLastT = frame.t;
      this._draw(bmp);
      if (bmp && bmp.close) bmp.close();
      this.drawn++;
      this.stats.frames++;
      // 首帧回调：页面用它收起加载遮罩。
      // 比"轮询 drawn 计数"可靠 —— 轮询可能因闭包/时序问题错过。
      if (this.drawn === 1 && this.o.onFirstFrame) {
        try { this.o.onFirstFrame(); } catch {}
      }
    };

    const fail = (why) => {
      this.decBusy = false;
      log('frame-decode-fail', why);
    };

    if (this.useBmp && !this.forceImg) {
      // 看门狗：createImageBitmap 挂起会让画面永久冻结（有声音无画面）
      const t = setTimeout(() => {
        if (this.decBusy) {
          this.forceImg = true;
          this.decBusy = false;
          log('bmp-decode-timeout', '强制切 Image 解码');
          // 关键：解锁后必须立刻重新走一次呈现。
          // 否则要等下一帧数据到达才会再进 _render —— 而如果服务端此刻正好
          // 在缓冲暂停（泵已停），下一帧迟迟不来，画面就会一直黑着。
          try { this._render(); } catch {}
        }
      }, 2000);

      createImageBitmap(new Blob([frame.data], { type: 'image/jpeg' }))
        .then((bmp) => { clearTimeout(t); done(bmp); })
        .catch((e) => { clearTimeout(t); fail(String(e && e.message)); });
      return;
    }

    // Image 路径。必须 revokeObjectURL，否则每帧泄漏一个 blob URL 及其底层数据。
    const url = URL.createObjectURL(new Blob([frame.data], { type: 'image/jpeg' }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); done(img); };
    img.onerror = () => { URL.revokeObjectURL(url); fail('img-error'); };
    img.src = url;
  }

  /** 等比缩放居中绘制，避免竖屏视频被拉伸变形。 */
  _draw(src) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const iw = src.width || src.naturalWidth;
    const ih = src.height || src.naturalHeight;
    if (!iw || !ih) return;
    const s = Math.min(cw / iw, ch / ih);
    const dw = iw * s, dh = ih * s;
    try {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, cw, ch);
      this.ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    } catch (e) {
      log('draw-fail', String(e && e.message));
    }
  }

  /* ======================================================================
     帧率统计与自动降档
     ====================================================================== */

  _startStats() {
    this.stats = { t0: Date.now(), frames: 0, low: 0, advanced: 0 };
    // 客户端停摆自愈：记录上次"真的画出画面"的时刻
    this.lastDrawnAt = Date.now();
    this.lastDrawnCount = this.drawn;
    this.stallReloads = 0;

    clearInterval(this.statIv);
    this.statIv = setInterval(() => {
      const now = Date.now();
      const span = (now - this.stats.t0) / 1000;
      if (span < 3) return;
      const fps = this.stats.frames / span;
      const advanced = this.stats.advanced;
      this.stats = { t0: now, frames: 0, low: 0, advanced: 0 };

      // 有画面产出就刷新时刻
      if (this.drawn !== this.lastDrawnCount) {
        this.lastDrawnCount = this.drawn;
        this.lastDrawnAt = now;
        this.stallReloads = 0;
      }

      if (this.o.onStats) this.o.onStats({ fps, advanced, drawn: this.drawn, dropped: this.dropped, buffered: this.buffer.length, pumpPaused: this.pumpPaused });

      /* ── 客户端停摆自愈（关键兜底） ────────────────────────────────
         服务端的空闲看门狗要 600s 才反应，而画面一旦卡住用户立刻就能看到。
         这里做客户端侧的独立检测：只要"音频在推进"却"长时间没有新画面"
         （缓冲区里明明有帧、却没画出来），就判定为渲染/解码链路卡死，
         主动重建连接自愈。

         两种成因都会走到这里：
           · 解码器/解码路径卡死（createImageBitmap 挂起等）
           · 服务端 ffmpeg 已经不再出帧，但连接还挂着（客户端毫无察觉）

         注意只在"音频在推进"时判定 —— 用户主动暂停不算故障。 */
      const audioMoving = this.audio && !this.audio.paused && this.audio.readyState >= 1;
      if (audioMoving && now - this.lastDrawnAt > this.stallMs) {
        this.stallReloads++;
        const buffered = this.buffer.length;
        log('client-stall', { ms: now - this.lastDrawnAt, buffered, reloads: this.stallReloads });

        if (this.o.onStall) this.o.onStall({ reloads: this.stallReloads, buffered });

        if (this.stallReloads >= STALL_MAX_RELOADS) {
          // 连续多次自愈无效：多半是这一档位/这一路源有问题，回退一档再试
          if (this.qualities && this.qualityIdx < this.qualities.length - 1) {
            this.qualityIdx++;
            log('client-stall-downgrade', { qIdx: this.qualityIdx });
            if (this.o.onQualityChange) this.o.onQualityChange(this.qualityIdx);
          }
          this.stallReloads = 0;
        }

        this.lastDrawnAt = now;
        // 重置解码锁：卡死时 decBusy 可能永远为 true，导致 _render 一直 return
        this.decBusy = false;
        this.decLastT = -1;
        this._hardReconnect();
      }

      // 降档只解决"帧在来但解码慢"。"帧根本不来"是链路问题，降档无用。
      if (advanced > 0 && fps < 8) {
        this.stats.low++;
        if (this.stats.low >= 2 && this.qualities && this.qualityIdx < this.qualities.length - 1) {
          this.qualityIdx++;
          log('quality-downgrade', { qIdx: this.qualityIdx, fps: fps.toFixed(1) });
          if (this.o.onQualityChange) this.o.onQualityChange(this.qualityIdx);
          this.stats.low = 0;
        }
      }
    }, 3000);
  }

  /** 强制重建连接（停摆自愈用）：保留缓冲以盖住重连空窗。 */
  _hardReconnect() {
    if (this.destroyed || !this.running) return;
    const pos = this.posMs() ?? 0;
    this.gen++;
    if (this.ws) {
      try { this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null; this.ws.close(); } catch {}
      this.ws = null;
    }
    log('ws-hard-reconnect', pos.toFixed(1));
    this._connect(pos);
  }

  /** 由外部在音频推进时调用，用于统计"本窗口确实有新帧"。 */
  markAdvanced() { this.stats.advanced++; }

  /* ======================================================================
     seek：快速路径（缓冲已覆盖）与重连路径
     ====================================================================== */

  seek(sec) {
    const pos = this.posMs();
    // 快速路径：目标位置仍被缓冲覆盖（前方余量 >1.5s）→ 不重连，只丢旧帧，音画立即对齐
    if (pos !== null) {
      const ahead = this.buffer.filter((f) => f.t > sec && f.t <= sec + 1.5);
      if (ahead.length > 1) {
        const keep = this.buffer.filter((f) => f.t >= sec - 1);
        this.buffer.length = 0;
        this.buffer.push(...keep);
        this.decLastT = -1;
        log('seek-fast', sec.toFixed(1));
        return;
      }
    }
    // 重连路径：收紧预卷，过大的预卷会拉长拖动后"新画面到达前"的音画错位窗口
    this.gen++;
    if (this.ws) {
      try { this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null; this.ws.close(); } catch {}
      this.ws = null;
    }
    this.decLastT = -1;
    log('seek-reconnect', sec.toFixed(1));
    this._connect(sec);
  }

  /** 诊断用：返回内部状态快照。 */
  stats() {
    return {
      running: this.running,
      destroyed: this.destroyed,
      buffered: this.buffer.length,
      bufFirst: this.buffer.length ? +this.buffer[0].t.toFixed(2) : null,
      bufLast: this.buffer.length ? +this.buffer[this.buffer.length - 1].t.toFixed(2) : null,
      drawn: this.drawn,
      dropped: this.dropped,
      decBusy: this.decBusy,
      decLastT: this.decLastT,
      forceImg: this.forceImg,
      useBmp: this.useBmp,
      lagging: !!this.lagging,
      audioT: this.audio ? +this.audio.currentTime.toFixed(2) : null,
      audioPaused: this.audio ? this.audio.paused : null,
      audioReady: this.audio ? this.audio.readyState : null,
      posMs: this.posMs(),
      wsState: this.ws ? this.ws.readyState : null,
    };
  }

  statsText() {
    const pos = this.posMs();
    const cushion = pos === null ? 0 : this._bufferedAhead(pos);
    return `缓冲${cushion.toFixed(0)}s 囤${this.buffer.length}帧${this.pumpPaused ? ' 泵已暂停' : ''}`;
  }
}

/* ============================================================================
   画布尺寸管理
   ----------------------------------------------------------------------------
   画布内部尺寸决定解码/绘制开销：窗口小的时候没必要按 960x540 解码。
   全屏时用窗口尺寸，窗口模式用档位尺寸。
   ============================================================================ */

export function sizeCanvas(canvas, quality, isFullscreen) {
  let w = quality.w, h = quality.h;
  if (isFullscreen) {
    const rect = canvas.getBoundingClientRect();
    w = Math.max(640, Math.round(rect.width));
    h = Math.max(360, Math.round(rect.height));
  }
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/* ============================================================================
   音画补偿（方向盘/按钮调节，持久化）
   ============================================================================ */

const SYNC_KEY = 'tp_av_sync';

export function loadSyncLag(def = 0.12) {
  const v = parseFloat(localStorage.getItem(SYNC_KEY));
  return Number.isFinite(v) ? clamp(v, 0, 3) : def;
}

export function saveSyncLag(v) {
  try { localStorage.setItem(SYNC_KEY, String(clamp(v, 0, 3))); } catch {}
}
