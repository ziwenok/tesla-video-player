/* ============================================================================
   核心 · WebCodecs 播放引擎 (core/webcodecs.js)
   ----------------------------------------------------------------------------
   为什么需要它
     帧流引擎（frames.js）靠服务端 ffmpeg 把每一帧编成 JPEG 再推过来，服务端
     CPU 开销很大（每个观看者一路 ffmpeg）。车机浏览器是 Chrome 140+，支持
     WebCodecs：服务端只需按需切片（-c:v copy，几乎不耗 CPU），浏览器用硬件
     解码器出画面，然后 drawImage 到 canvas —— 同样绕开 D 档限制（没有 <video>
     元素参与显示）。

   以下每条都是实测踩出来的（重写前 player.html 里有原始记录），改动前先读：
     A) 无背压 → 帧无限堆积：实测 12s 内 dec=3246 / draw=243，pending 从 260
        涨到 2559。必须按窗口喂，让 pending 稳定在约 1 秒的帧数。
     B) 一次 EncodingError 后按规范解码器即为 closed，之后再 decode() 只会抛
        InvalidStateError —— 画面永久冻结、只剩声音（用户反馈的"有声无画"）。
        必须：出错立即上报播放器切换到帧流引擎，音频不中断。
     C) 预取是并发的，旧代码"谁先下完谁先喂" → 乱序喂 H.264 → 就是 B 的触发源。
        必须：下载可并发，但解封装/喂入严格按段序。
     D) isConfigSupported 是异步的，要加闸门避免重复 configure 重置解码器。
     E) 首段（或 seek/flush 之后）必须从关键帧开始喂，否则解码器直接报错自锁。
     F) 预取只跟播放头 2 段（旧实现会级联把整片 400+ 段全拉下来）。
     G) dispose 之后不许再喂块，否则 InvalidStateError 刷屏。
     H) seek 后解码器 flush 出来的旧帧（pts 早于目标段）要丢掉，避免闪回旧画面。
   ============================================================================ */

import { log } from './log.js';

const DEC_WINDOW = 24;     // 解码窗口：最多领先播放头约 1s（1080p24）
const PEND_CAP   = 600;    // pending 兜底上限（窗口逻辑正常时永远到不了）
const PREFETCH   = 2;      // 只跟着播放头预取 2 段
const SEG_RETRY  = 3;      // 单段下载重试次数

/** 懒加载 mp4box（只在真正用 WebCodecs 时才下载，避免拖慢其它页面）。 */
let mp4boxPromise = null;
function loadMP4Box() {
  if (!mp4boxPromise) {
    mp4boxPromise = import('/vendor/mp4box.all.mjs').catch((e) => {
      log('mp4box-load-fail', String(e && e.message));
      return null;
    });
  }
  return mp4boxPromise;
}

export class WebCodecsEngine {
  /**
   * @param {object} opts
   *   canvas   {HTMLCanvasElement}
   *   audio    {HTMLAudioElement}  主时钟
   *   name     {string} 视频文件名
   *   syncLag  {number} 音画补偿秒
   *   onFatal  {function(msg)} 解码器不可恢复时回调（播放器应切到帧流）
   *   onStats  {function(obj)}
   */
  constructor(opts) {
    this.o = opts;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.audio = opts.audio;
    this.name = opts.name;
    this.syncLag = opts.syncLag ?? 0.12;

    this.decoder = null;
    this.mp4box = null;
    this.meta = null;
    this.segs = [];           // [{file,start,dur,size,state:'idle'|'loading'|'done'|'failed'}]
    this.chunkQ = [];         // 待喂入的 EncodedVideoChunk（按段序）
    this.pending = [];        // 已解码待呈现 {frame, ptsUs}
    this.queuedSeg = 0;       // 已入队的段下标（严格递增喂入）
    this._loadToken = 0;
    this._configured = false;
    this._configuring = false;
    this._failed = false;
    this._disposed = false;
    this._needKey = true;
    this._minPtsUs = 0;
    this._playT = 0;
    this._config = null;
    this.framesDrawn = 0;
  }

  get kind() { return 'webcodecs'; }

  /* ======================================================================
     启动
     ====================================================================== */

  async init() {
    this.mp4box = await loadMP4Box();
    if (!this.mp4box) throw new Error('mp4box 加载失败');

    // 等待服务端切片就绪（h264 通常秒级）
    const ok = await this._waitSegments();
    if (!ok) throw new Error('切片未就绪');
    if (this._disposed) return;

    const res = await fetch(`/api/segments/${encodeURIComponent(this.name)}/meta.json`);
    if (!res.ok) throw new Error('meta.json 不可用');
    this.meta = await res.json();
    this.segs = (this.meta.segments || []).map((s) => ({ ...s, state: 'idle' }));
    if (!this.segs.length) throw new Error('无切片');

    log('wc-ready', { segs: this.segs.length, duration: this.meta.duration });
  }

  async _waitSegments(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this._disposed) return false;
      try {
        const r = await fetch(`/api/segments/${encodeURIComponent(this.name)}?status=1`);
        const d = await r.json();
        if (d.status === 'ready') return true;
        if (d.status === 'error') throw new Error('服务端切片失败');
      } catch (e) {
        if (/切片失败/.test(String(e && e.message))) throw e;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /* ======================================================================
     解码器配置
     ====================================================================== */

  /** 从 mp4box 的 avcC box 提取 description（BIG_ENDIAN DataStream）。 */
  _extractAvcC(mp4) {
    const track = mp4.getTrackById(this._videoTrackId);
    if (!track || !track.mdia || !track.mdia.minf || !track.mdia.minf.stbl) return null;
    const entry = track.mdia.minf.stbl.stsd.entries.find(
      (e) => e.avcC || e.hvcC || e.vpcC || e.av1C
    );
    if (!entry) return null;
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    const DS = this.mp4box.DataStream;
    const ds = new DS(undefined, { box: 'avcC' });   // BIG_ENDIAN
    box.write(ds);
    return new Uint8Array(ds.buffer.slice(8, box.size));
  }

  async _configure(description, width, height, codec) {
    if (this._configured || this._configuring || this._disposed) return;
    this._configuring = true;

    const config = {
      codec,
      width,
      height,
      description,
      optimizeForLatency: false,
    };

    try {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) throw new Error('解码器不支持 ' + codec);
      if (this._disposed) return;

      this.decoder = new VideoDecoder({
        output: (frame) => this._onFrame(frame),
        error: (e) => this._onDecodeError(e),
      });
      this.decoder.configure(config);
      this._config = config;
      this._configured = true;
      // canvas 内部尺寸跟随源分辨率（等比缩放由 CSS object-fit 负责）
      this.canvas.width = width;
      this.canvas.height = height;
      log('wc-configured', { codec, width, height });
    } finally {
      this._configuring = false;
    }
  }

  /* ======================================================================
     切片下载与解封装
     ====================================================================== */

  _segUrl(i) {
    return `/api/segments/${encodeURIComponent(this.name)}/${this.segs[i].file}`;
  }

  async _fetchSeg(i, token) {
    const s = this.segs[i];
    if (!s || s.state === 'done' || s.state === 'loading') return;
    s.state = 'loading';
    s.try = (s.try || 0) + 1;

    try {
      const res = await fetch(this._segUrl(i));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      if (token !== this._loadToken || this._disposed) return;

      // 用 mp4box 解封装（此时 mp4box 已加载，是同步的）
      await this._demux(i, buf);
      s.state = 'done';
    } catch (e) {
      if (token !== this._loadToken) return;
      s.state = s.try >= SEG_RETRY ? 'failed' : 'idle';
      log('wc-seg-fail', { i, try: s.try, msg: String(e && e.message) });
    }
  }

  _demux(i, buffer) {
    return new Promise((resolve) => {
      const mp4 = this.mp4box.createFile();
      let settled = false;
      const finish = () => { if (!settled) { settled = true; try { mp4.stop(); } catch {} resolve(); } };

      mp4.onError = (e) => { log('wc-demux-error', String(e)); finish(); };

      mp4.onReady = (info) => {
        this._videoTrackId = info.videoTracks[0] && info.videoTracks[0].id;
        if (this._videoTrackId === undefined) { log('wc-no-video-track'); return finish(); }

        const track = info.videoTracks[0];
        if (!this._configured && !this._configuring) {
          const desc = this._extractAvcC(mp4);
          if (desc) {
            this._configure(desc, track.video.width, track.video.height, track.codec).catch((e) => {
              this._onDecodeError(e);
            });
          }
        }
        mp4.setExtractionOptions(this._videoTrackId, null, { nbSamples: 1e9 });
        mp4.start();
      };

      mp4.onSamples = (id, user, samples) => {
        const isFirstOfStream = this.queuedSeg === 0;
        for (const s of samples) {
          // 首段（或 seek/flush 之后）必须从关键帧开始喂，否则解码器直接 EncodingError 自锁
          if (this._needKey && !s.is_sync) continue;
          if (this._needKey && s.is_sync) this._needKey = false;

          this.chunkQ.push({
            type: 'key',
            timestamp: Math.round((s.cts / s.timescale) * 1e6),
            duration: Math.round((s.duration / s.timescale) * 1e6),
            data: s.data,
            isFirstOfStream,
          });
        }
        finish();
      };

      try {
        buffer.fileStart = 0;
        mp4.appendBuffer(buffer);
        mp4.flush();
      } catch (e) {
        log('wc-append-error', String(e && e.message));
        finish();
      }

      // 兜底：mp4box 偶发不回调
      setTimeout(finish, 4000);
    });
  }

  /* ======================================================================
     喂入（严格按段序 + 背压）
     ====================================================================== */

  _canDecode() {
    if (!this.decoder) return false;
    return (this.pending.length + this.decoder.decodeQueueSize) < DEC_WINDOW;
  }

  _pump() {
    if (this._disposed || this._failed || !this.decoder) return;

    // 严格按段序：只有当前段解封装完，才允许推进 queuedSeg
    while (this.queuedSeg < this.segs.length) {
      const s = this.segs[this.queuedSeg];
      if (s.state !== 'done') break;
      this.queuedSeg++;
    }

    this._feed();
    this._prefetch();
    this._trim();
  }

  _feed() {
    if (!this.decoder || this._failed) return;
    while (this.chunkQ.length && this._canDecode()) {
      const c = this.chunkQ.shift();
      // 播放头已经越过的整段直接跳过，不浪费解码
      const seg = this.segs[this.queuedSeg - 1];
      if (seg && (seg.start + seg.dur) < this._playT - 0.5) continue;
      try {
        this.decoder.decode(new EncodedVideoChunk({
          type: c.type,
          timestamp: c.timestamp,
          duration: c.duration,
          data: c.data,
        }));
      } catch (e) {
        this._onDecodeError(e);
        return;
      }
    }
  }

  _prefetch() {
    // 只跟着播放头预取 2 段（旧实现会级联把整片全拉下来）
    const token = this._loadToken;
    let started = 0;
    for (let i = this.queuedSeg; i < this.segs.length && started < PREFETCH; i++) {
      const s = this.segs[i];
      if (s.state === 'idle') { this._fetchSeg(i, token); started++; }
      else if (s.state === 'loading') started++;
    }
  }

  /** 兜底：窗口逻辑万一失效也不让帧无限堆积。 */
  _trim() {
    if (this.pending.length > PEND_CAP) {
      const drop = this.pending.length - DEC_WINDOW;
      for (let i = 0; i < drop; i++) {
        const p = this.pending.shift();
        try { p.frame.close(); } catch {}
      }
      log('wc-pending-trim', drop);
    }
  }

  /* ======================================================================
     解码回调
     ====================================================================== */

  _onFrame(frame) {
    if (this._disposed) { try { frame.close(); } catch {} return; }

    const ptsUs = frame.timestamp;
    // seek 之后解码器 flush 出来的旧帧（pts 早于目标段）直接丢掉，避免闪回旧画面
    if (ptsUs < this._minPtsUs) { try { frame.close(); } catch {} return; }

    this.pending.push({ frame, ptsUs });
    // 乱序输出时保持 pts 有序
    if (this.pending.length > 1 && this.pending[this.pending.length - 2].ptsUs > ptsUs) {
      this.pending.sort((a, b) => a.ptsUs - b.ptsUs);
    }
  }

  _onDecodeError(e) {
    if (this._failed || this._disposed) return;
    this._failed = true;
    const msg = String((e && e.message) || e || 'decode error');
    log('wc-fatal', msg);
    // 按 WebCodecs 规范，error 回调后解码器状态即为 closed，再 decode() 只会抛
    // InvalidStateError。这里必须让播放器切到帧流引擎，否则"有声无画"。
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    this.decoder = null;
    if (this.o.onFatal) this.o.onFatal(msg);
  }

  /* ======================================================================
     渲染：跟随音频时钟
     ====================================================================== */

  tick(audioTime) {
    if (this._disposed) return;
    this._playT = audioTime;
    this._pump();

    if (!this._configured || !this.pending.length) return;

    // 时钟 + 用户校准。注意符号：画面比声音慢 syncLag 秒
    const tUs = Math.round((audioTime - this.syncLag) * 1e6);

    // 找出 pts <= t 的最新帧：更早的丢掉，留下一个 held
    let shown = null;
    while (this.pending.length && this.pending[0].ptsUs <= tUs) {
      if (shown) { try { shown.frame.close(); } catch {} }
      shown = this.pending.shift();
    }
    if (!shown) return;

    try {
      this.ctx.drawImage(shown.frame, 0, 0, this.canvas.width, this.canvas.height);
      this.framesDrawn++;
    } catch (e) {
      log('wc-draw-fail', String(e && e.message));
    } finally {
      try { shown.frame.close(); } catch {}
    }
  }

  /* ======================================================================
     seek / 销毁
     ====================================================================== */

  async seek(sec) {
    if (this._disposed) return;
    const token = ++this._loadToken;

    // 清空待处理
    this.chunkQ.length = 0;
    for (const p of this.pending) { try { p.frame.close(); } catch {} }
    this.pending.length = 0;

    if (this.decoder && this.decoder.state === 'configured') {
      try { await this.decoder.flush(); } catch {}
      try { this.decoder.reset(); this.decoder.configure(this._config); } catch (e) {
        this._onDecodeError(e);
        return;
      }
    }

    this._needKey = true;
    this._minPtsUs = Math.round(sec * 1e6);

    // 目标段无论之前什么状态都要重来：seek 清空了 pending/chunkQ，
    // 若仍标成 done 就再也不会有新帧产出 → 黑屏一直到该段结束
    const idx = this.segs.findIndex((s) => s.start + s.dur >= sec);
    const from = idx < 0 ? this.segs.length - 1 : idx;
    for (let i = from; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (s.state === 'done') s.state = 'idle';
    }
    this.queuedSeg = from;
    this._playT = sec;
    log('wc-seek', { sec: sec.toFixed(1), from });
    this._pump();
  }

  dispose() {
    this._disposed = true;
    this._loadToken++;
    for (const p of this.pending) { try { p.frame.close(); } catch {} }
    this.pending.length = 0;
    this.chunkQ.length = 0;
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    this.decoder = null;
  }

  statsText() {
    return `原生解码 · 段 ${this.queuedSeg}/${this.segs.length} · 待解码 ${this.pending.length}`;
  }

  stats() {
    return {
      kind: 'webcodecs',
      drawn: this.framesDrawn,
      pending: this.pending.length,
      queuedSeg: this.queuedSeg,
      total: this.segs.length,
      failed: this._failed,
    };
  }
}
