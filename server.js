import express from 'express';
import http, { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { readdir, stat, readFile, mkdir, unlink, appendFile, writeFile, rm, statfs } from 'fs/promises';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync, createWriteStream, rmSync, appendFileSync } from 'fs';
import { createReadStream } from 'fs';
import { execFile, spawn, spawn as spawnRaw, exec, execSync } from 'child_process';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ────────────────────────────────────────────────────────
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = 3443;
const VIDEOS_DIR = process.env.VIDEOS_DIR || join(__dirname, 'videos');
const SUBTITLES_DIR = process.env.SUBTITLES_DIR || join(__dirname, 'subtitles');
const CACHE_DIR = join(VIDEOS_DIR, '.cache');
const SEGS_DIR = join(VIDEOS_DIR, '.segments');
const THUMB_DIR = join(VIDEOS_DIR, '.thumbs');
const LYRICS_DIR = join(__dirname, 'lyrics');
const MUSIC_DIR = join(__dirname, 'music');
const MIC_LOG_DIR = join(__dirname, 'logs');
const HLS_DIR = '/tmp/bili_hls';
const AUDIO_TMP = '/tmp/bili_audio';
const DIRECT_CODECS = new Set(['h264']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov', '.ts', '.m4v']);
const MUSIC_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac']);
const SEGS_MAX_BYTES = (parseFloat(process.env.SEGS_MAX_GB || '15')) * 1024 * 1024 * 1024;

// ─── FFmpeg Process Manager ───────────────────────────────────────────
const ffmpegProcs = new Map(); // pid -> { proc, label, timer }

function spawnTracked(args, opts = {}, label = 'ffmpeg') {
  // 加固 v2 (S1): opts.timeout 原本被 ...opts 透传给 spawn()。Node 的 spawn
  // timeout 是**无视活动**的硬杀(默认 SIGTERM)，于是下面那个"空闲看门狗"被
  // 架空 —— 直播/长视频到点照样被杀，正是「9 分多钟卡住」的同一类故障。
  // 现在把 timeout 从 spawn 选项里摘出来，只当空闲看门狗的时长用。
  const { timeout: idleTimeout, ...spawnOpts } = opts;
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
  const entry = { proc, label, timer: null, created: Date.now(), dead: false, arm: null };
  ffmpegProcs.set(proc.pid, entry);
  const timeout = idleTimeout || 600000;
  // 空闲看门狗, 不是绝对时限。原实现是"启动后 N 分钟无条件 SIGKILL", 对**流式**进程
  // 是错的: 一路健康的直播/长视频播到第 10 分钟会被无差别杀掉, 客户端只能重连
  // (车机上表现为「9 分多钟卡住, 之后一直缓冲」)。
  // 改成空闲语义后: 只要还在出数据就不杀, 真挂住(不再出数据)才杀。
  // 写文件的转码任务 stdout 无数据, 行为与原来一致(仍是 N 分钟上限)。
  entry.arm = () => {
    if (entry.dead) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      console.warn(`[ffmpeg] idle timeout kill pid=${proc.pid} label=${label} after ${timeout}ms 无输出`);
      try { proc.kill('SIGKILL'); } catch {}
    }, timeout);
  };
  entry.arm();
  if (proc.stdout) proc.stdout.on('data', entry.arm);
  proc.on('exit', () => { entry.dead = true; if (entry.timer) clearTimeout(entry.timer); ffmpegProcs.delete(proc.pid); });
  proc.on('error', () => { entry.dead = true; if (entry.timer) clearTimeout(entry.timer); ffmpegProcs.delete(proc.pid); });
  return proc;
}

// 看门狗重新计时(有进展) / 挂起计时(用户主动暂停, 不该被当成挂住)
function touchProc(proc) { const e = ffmpegProcs.get(proc.pid); if (e && e.arm) e.arm(); }
function holdProc(proc) { const e = ffmpegProcs.get(proc.pid); if (e && e.timer) { clearTimeout(e.timer); e.timer = null; } }

function killProc(proc) { try { proc.kill('SIGKILL'); } catch {} }

function cleanupAllFfmpeg() {
  let count = 0;
  for (const [, { proc, label }] of ffmpegProcs) {
    try { proc.kill('SIGKILL'); count++; console.log(`[cleanup] killed ${label} pid=${proc.pid}`); } catch {}
  }
  ffmpegProcs.clear();
  return count;
}

// 加固 v2 (S11): 原实现没有任何 unhandledRejection/uncaughtException 兜底，
// 任一未捕获异常（例如定时器回调里抛错）都会让整个服务退出，车机端表现为
// "全站打不开"。这里记录并继续存活。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

// ─── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use("/api/", (req, res, next) => { res.setHeader("Cache-Control", "no-cache, no-store"); next(); });
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
// ─── 上传服务同源反向代理 ─────────────────────────────────────────────
// 上传 API 在独立服务(默认 3001)，而本服务(3000/3443)提供上传页面。
// 直接跨域调用会被浏览器拒绝（3001 不返回 CORS 头），HTTPS 下还会被当混合内容拦掉。
// 这里做一层同源代理，前端用相对路径 /api/upload/* 即可。
// 注意：必须流式转发，不能把请求体缓冲进内存（单个分块 16MB）。
const UPLOAD_UPSTREAM = process.env.UPLOAD_UPSTREAM || 'http://127.0.0.1:3001';

app.use('/api/upload', (req, res) => {
  const target = new URL(req.originalUrl, UPLOAD_UPSTREAM);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // host 要换成上游的；connection 由 http 模块自己管
    if (k === 'host' || k === 'connection') continue;
    headers[k] = v;
  }
  headers.host = target.host;

  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method: req.method,
    headers,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });

  upstream.on('error', (e) => {
    console.error('[upload-proxy]', e.message);
    if (!res.headersSent) res.status(502).json({ error: '上传服务不可用: ' + e.message });
    else try { res.end(); } catch {}
  });

  // 客户端中断时及时释放上游连接
  res.on('close', () => { try { upstream.destroy(); } catch {} });

  req.pipe(upstream);
});

app.use(express.json());
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
app.use(express.static(join(__dirname, 'public')));

// /livetv local file priority (aggregator output)
app.use('/livetv', async (req, res, next) => {
  if (req.path === '/live.m3u') {
    try {
      const data = await readFile(join('/home/ubuntu/iptv-api/output', req.path), 'utf-8');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(data);
      return;
    } catch (e) {}
  }
  next();
});

// /livetv live source proxy -> iptv-api (docker, port 8000)
app.use('/livetv', async (req, res) => {
  try {
    const u = await fetch('http://127.0.0.1:8000' + req.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' }
    });
    const b = Buffer.from(await u.arrayBuffer());
    res.status(u.status);
    res.setHeader('Content-Type', u.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(b);
  } catch (e) {
    res.status(502).end('Bad Gateway');
  }
});


// ═══ 加固补丁 v3 ═══
// S14: /api/videos 会对每个未缓存文件并发 ffprobe（每个都是独立进程）。
// 文件一多就瞬间拉起大量进程。这里加一个全局并发闸门。
const PROBE_MAX_PAR = Math.max(1, parseInt(process.env.PROBE_MAX_PAR || '4', 10));
let probeRunning = 0;
const probeWaiters = [];

function probeAcquire() {
  if (probeRunning < PROBE_MAX_PAR) { probeRunning++; return Promise.resolve(); }
  return new Promise((resolve) => probeWaiters.push(resolve));
}

function probeRelease() {
  const next = probeWaiters.shift();
  if (next) next();               // 名额直接转交，不减少计数
  else probeRunning = Math.max(0, probeRunning - 1);
}

// ─── Codec / Transcode Pipeline ───────────────────────────────────────
const codecCache = new Map();
const transcodeJobs = new Map();
const segJobs = new Map();
const transcodeQueue = [];
let transcodeConcurrent = 0;
const TRANSCODE_MAX = 2;
const segQueue = [];
let segConcurrent = 0;

function ffprobeVideo(file) {
  // 加固 v3 (S14): 经全局并发闸门，避免大量文件同时 ffprobe 拉起过多进程。
  // 每个分支都必须 probeRelease()，否则名额泄漏会把闸门卡死。
  return probeAcquire().then(() => new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { timeout: 30000 }, (err, stdout) => {
      probeRelease();
      if (err) return resolve(null);
      resolve(stdout.trim().split('\n')[0] || null);
    });
  }));
}

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(0);
      resolve(parseFloat(stdout.trim()) || 0);
    });
  });
}

async function getCodec(filename) {
  if (codecCache.has(filename)) return codecCache.get(filename);
  const codec = await ffprobeVideo(join(VIDEOS_DIR, filename));
  codecCache.set(filename, codec || 'unknown');
  return codecCache.get(filename);
}

function cachePath(filename) { return join(CACHE_DIR, filename.replace(/\.[^.]+$/, '') + '-h264.mp4'); }
function audioCachePath(filename) { return join(CACHE_DIR, filename.replace(/\.[^.]+$/, '') + '-audio.m4a'); }
function segDir(filename) { return join(SEGS_DIR, filename.replace(/\.[^.]+$/, '')); }
function segMetaPath(filename) { return join(segDir(filename), 'meta.json'); }

function startTranscode(filename) {
  if (transcodeJobs.has(filename)) return;
  if (transcodeConcurrent >= TRANSCODE_MAX) { transcodeQueue.push(filename); transcodeJobs.set(filename, { status: 'queued' }); return; }
  runTranscodeJob(filename);
}

function runTranscodeJob(filename) {
  transcodeConcurrent++;
  const input = join(VIDEOS_DIR, filename);
  const output = cachePath(filename);
  const proc = spawnTracked([
    '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-vf', 'scale=-2:720',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output
  ], { timeout: 3600000 }, `transcode:${filename}`);
  const job = { status: 'transcoding', process: proc };
  let stderrTail = '';
  proc.stderr.on('data', (d) => { stderrTail = d.toString(); });
  // 加固 v2 (S2): error 与 close 可能**都**触发，原实现各调一次 finish()，
  // 并发计数被双减 → 变负 → 限流失效（能跑超过 TRANSCODE_MAX 个任务）。
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    transcodeConcurrent = Math.max(0, transcodeConcurrent - 1);
    const next = transcodeQueue.shift();
    if (next) runTranscodeJob(next);
  };
  proc.on('close', async (code) => {
    if (code === 0) { job.status = 'ready'; console.log(`[transcode] ${filename} -> ready`); transcodeJobs.delete(filename); }
    else { job.status = 'error'; console.error(`[transcode] ${filename} failed: ${stderrTail.slice(-500)}`); setTimeout(() => transcodeJobs.delete(filename), 60000); try { await unlink(output); } catch {} }
    finish();
  });
  proc.on('error', () => { job.status = 'error'; setTimeout(() => transcodeJobs.delete(filename), 60000); finish(); });
  transcodeJobs.set(filename, job);
}

async function buildSegMeta(filename, outDir) {
  const files = (await readdir(outDir)).filter((f) => /^seg-\d{5}\.mp4$/.test(f)).sort();
  if (!files.length) throw new Error('no segments produced');
  const segments = [];
  let start = 0;
  for (const f of files) {
    const p = join(outDir, f);
    const dur = await ffprobeDuration(p);
    const size = (await stat(p)).size;
    segments.push({ file: f, start: +start.toFixed(3), dur: +dur.toFixed(3), size });
    start += dur;
  }
  return { name: filename, duration: +start.toFixed(3), segments };
}

async function waitForTranscode(filename) {
  for (let i = 0; i < 3600; i++) {
    const job = transcodeJobs.get(filename);
    if (!job) return existsSync(cachePath(filename));
    if (job.status === 'ready') return true;
    if (job.status === 'error') return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

function runSegJob(filename, source) {
  segConcurrent++;
  const outDir = segDir(filename);
  const job = { status: 'segmenting' };
  segJobs.set(filename, job);
  // 加固 v2 (S2): 同 runTranscodeJob，error 与 close 只能结算一次。
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    segConcurrent = Math.max(0, segConcurrent - 1);
    const next = segQueue.shift();
    if (next) runSegJob(next.filename, next.source);
  };
  (async () => {
    try { await mkdir(outDir, { recursive: true }); for (const f of await readdir(outDir)) { if (f !== 'meta.json') await unlink(join(outDir, f)).catch(() => {}); } } catch {}
    let tail = '';
    const proc = spawnTracked([
      '-y', '-i', source, '-an', '-c:v', 'copy',
      '-f', 'segment', '-segment_time', '10', '-break_non_keyframes', '1', '-reset_timestamps', '1',
      join(outDir, 'seg-%05d.mp4')
    ], { timeout: 3600000 }, `segment:${filename}`);
    proc.stderr.on('data', (d) => { tail += d.toString(); if (tail.length > 4000) tail = tail.slice(-4000); });
    proc.on('close', async (code) => {
      let ok = false;
      if (code === 0) {
        try {
          const meta = await buildSegMeta(filename, outDir);
          await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta));
          job.status = 'ready'; ok = true;
          console.log(`[segments] ${filename} -> ready (${meta.segments.length} segs)`);
          const codec = await getCodec(filename);
          if (codec && !DIRECT_CODECS.has(codec)) { await unlink(cachePath(filename)).catch(() => {}); console.log(`[cache] freed ${filename}`); }
        } catch (e) { job.status = 'error'; console.error(`[segments] ${filename} meta failed:`, e); }
      } else { job.status = 'error'; console.error(`[segments] ${filename} failed: ${tail.slice(-400)}`); }
      if (!ok) setTimeout(() => segJobs.delete(filename), 60000);
      finish();
    });
    proc.on('error', (e) => { job.status = 'error'; console.error(`[segments] ${filename} spawn error:`, e); setTimeout(() => segJobs.delete(filename), 60000); finish(); });
  })();
}

function startSegmentation(filename, source) {
  if (segJobs.has(filename) || existsSync(segMetaPath(filename))) return;
  if (segConcurrent >= 3) { segQueue.push({ filename, source }); segJobs.set(filename, { status: 'queued' }); return; }
  runSegJob(filename, source);
}

function extractAudio(filename, source) {
  return new Promise((resolve) => {
    const out = audioCachePath(filename);
    // 加固 v2 (S5): 直接写最终文件时, existsSync 会在文件还残缺时就为真,
    // 客户端据此判定 ready 并开始下载 → 得到半个 m4a（audio-error code=4）。
    // 改为写临时文件再原子 rename，保证"可见即可用"。
    // 注意：临时名必须**保留原扩展名**。若写成 xxx.m4a.tmp，ffmpeg 无法从
    // 后缀推断封装格式，会直接报 "Error opening output files: Invalid argument"。
    const tmp = out.replace(/(\.[^.]+)$/, '.tmp$1');
    const p = spawnTracked(['-y', '-i', source, '-map', '0:a:0', '-c:a', 'copy', '-movflags', '+faststart', tmp], { timeout: 300000 }, `audio:${filename}`);
    let tail = '';
    p.stderr.on('data', (d) => { tail += d.toString(); if (tail.length > 2000) tail = tail.slice(-2000); });
    p.on('close', async (code) => {
      if (code === 0) {
        try { renameSync(tmp, out); console.log(`[audio] ${filename} -> ready`); resolve(true); }
        catch (e) { console.error(`[audio] ${filename} rename failed:`, e); try { await unlink(tmp); } catch {} resolve(false); }
      } else {
        console.error(`[audio] ${filename} failed: ${tail.slice(-300)}`);
        try { await unlink(tmp); } catch {}
        resolve(false);
      }
    });
    p.on('error', async () => { try { await unlink(tmp); } catch {} resolve(false); });
  });
}

async function ensureSegmentation(filename) {
  if (existsSync(segMetaPath(filename))) return;
  if (segJobs.has(filename)) return;
  const codec = await getCodec(filename);
  if (!codec || codec === 'unknown') return;
  let source;
  if (DIRECT_CODECS.has(codec)) { source = join(VIDEOS_DIR, filename); if (!existsSync(audioCachePath(filename))) await extractAudio(filename, source); startSegmentation(filename, source); return; }
  source = cachePath(filename);
  if (!existsSync(source)) { startTranscode(filename); const ok = await waitForTranscode(filename); if (!ok || !existsSync(source)) return; }
  segJobs.set(filename, { status: 'extracting' });
  const audioOk = await extractAudio(filename, source);
  segJobs.delete(filename);
  if (!audioOk) return;
  startSegmentation(filename, source);
}

const segAccess = new Map();
function touchSeg(filename) { segAccess.set(filename, Date.now()); }

async function dirSize(dir) {
  let total = 0;
  try { for (const f of await readdir(dir)) { const st = await stat(join(dir, f)); if (st.isFile()) total += st.size; } } catch {}
  return total;
}

async function evictSegmentsIfNeeded() {
  let freeBytes = Infinity;
  try { const s = await statfs(VIDEOS_DIR); freeBytes = s.bavail * s.bsize; } catch {}
  const cap = Math.min(SEGS_MAX_BYTES, freeBytes - 5 * 1024 * 1024 * 1024);
  // 加固 v2 (S3): 原实现在 cap<=0（磁盘快满）时直接 return —— 最需要回收的
  // 时候反而不回收，只能等磁盘写满。现在照常按 LRU 回收，目标是腾出到
  // 保留线（free - 5GB）之上。
  if (cap <= 0) console.warn('[lru] 磁盘余量已低于保留线, 强制按 LRU 回收');
  let dirs;
  try { dirs = await readdir(SEGS_DIR); } catch { return; }
  let total = 0;
  const items = [];
  for (const d of dirs) {
    const dp = join(SEGS_DIR, d);
    let st;
    try { st = await stat(dp); } catch { continue; }
    if (!st.isDirectory()) continue;
    const size = await dirSize(dp);
    total += size;
    // 加固 v2 (S4): 访问键原为 `目录名 + '.mp4'`，而 touchSeg 存的是真实
    // 文件名 → .mkv/.ts 等源永远取不到访问时间，只能退回目录 mtime，
    // LRU 顺序失真。改为先按真实文件名查，再退回 .mp4 兼容旧键。
    const at = segAccess.get(d)
            || segAccess.get(d + '.mp4')
            || segAccess.get(d + '.mkv')
            || segAccess.get(d + '.ts')
            || segAccess.get(d + '.mov')
            || st.mtimeMs;
    items.push({ dir: dp, name: d, size, at });
  }
  if (total <= cap) return;
  items.sort((a, b) => a.at - b.at);
  for (const it of items) {
    if (total <= cap) break;
    if (segJobs.has(it.name) || segJobs.has(it.name + '.mp4') || it.size === 0) continue;
    await rm(it.dir, { recursive: true, force: true });
    segAccess.delete(it.name);
    total -= it.size;
    console.log(`[lru] evicted ${it.name} (${(it.size / 1048576).toFixed(0)}MB)`);
  }
}
setInterval(() => evictSegmentsIfNeeded().catch(() => {}), 60000);

async function resolveVideoPath(filename, res) {
  const directPath = join(VIDEOS_DIR, filename);
  const codec = await getCodec(filename);
  if (DIRECT_CODECS.has(codec)) return directPath;
  const cp = cachePath(filename);
  const job = transcodeJobs.get(filename);
  if (job) {
    if (job.status === 'ready' && existsSync(cp)) return cp;
    if (job.status === 'transcoding') { if (res) return res.status(202).json({ status: 'transcoding', codec }); }
    if (job.status === 'error') { if (res) return res.status(500).json({ status: 'error', codec }); }
  }
  if (existsSync(cp)) { const v = await ffprobeVideo(cp); if (v) return cp; await unlink(cp).catch(() => {}); }
  if (res) { startTranscode(filename); return res.status(202).json({ status: 'transcoding', codec }); }
  startTranscode(filename);
  return null;
}

// ─── WebSocket D档 帧流 ──────────────────────────────────────────────
const TEST_CLIP = join(__dirname, 'public', 'test', 'test-seg-720.mp4');
const wss = new WebSocketServer({ noServer: true });

// 加固 v2 (S10): :bv 会被直接拼进 /tmp/bili_audio 与 /tmp/bili_hls 的路径，
// 未校验时可读/可删任意文件与目录。BV 号本身是固定格式，白名单即可。
const BV_RE = /^BV[0-9A-Za-z]{10}$/;
function safeBv(v) {
  const s = String(v || '').trim();
  return BV_RE.test(s) ? s : null;
}

function safeVideoPath(filename) {
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return null;
  const ext = extname(filename).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return null;
  return join(VIDEOS_DIR, filename);
}

async function handleFrames(ws, url) {
  // 加固 v3 (S12): 本函数在 spawn 之前要 await 选源（最长十几秒），而 close
  // 监听原本挂在 spawn 之后。客户端若在这段窗口内断开，就没有任何监听器 ——
  // ffmpeg 随后被拉起、持续出数据，空闲看门狗因持续有输出而不断续命，
  // 于是进程永久残留、JPEG 缓冲无界增长。这里一进来就监听并置标志。
  let clientGone = false;
  ws.on('close', () => { clientGone = true; });
  ws.on('error', () => { clientGone = true; });
  if (ws.readyState !== 1) clientGone = true;

  const fps = Math.min(30, Math.max(1, parseInt(url.searchParams.get('fps') || '15', 10)));
  const w = Math.min(1280, parseInt(url.searchParams.get('w') || '960', 10));
  const h = Math.min(720, parseInt(url.searchParams.get('h') || '540', 10));
  const q = Math.min(31, Math.max(2, parseInt(url.searchParams.get('q') || '5', 10)));
  const loop = url.searchParams.get('loop') !== '0';
  // 加固 v2 (S15): parseFloat 失败会得到 NaN，而 writeUInt32LE(NaN) 会静默
  // 写 0 → 所有帧时间戳归零（画面时间轴失效）。这里兜底为 0。
  let seek = parseFloat(url.searchParams.get('seek') || '0');
  if (!Number.isFinite(seek) || seek < 0) seek = 0;
  const fileParam = url.searchParams.get('file');

  let inputFile = TEST_CLIP;
  let biliHeaders = null;
  let ytHeaders = false;
  let ytPipe = false;      // YouTube：走 yt-dlp 管道
  let liveCh = url.searchParams.get('live');
  let liveIdx = -1;                       // 本次实际选中的直播源下标(用于失败惩罚)
  const biliBv = url.searchParams.get('bili');
  const ytId = parseYouTubeId(url.searchParams.get('yt') || '');
  if (liveCh) {
    // 直播 D档: 用直播源实时拉帧 (无 loop, 无 seek)
    const chan = liveChan(liveCh);
    if (!chan) { try { ws.close(4003, 'live no channel'); } catch {} return; }
    try {
      // 走源仲裁: 与 /api/live/:ch/audio 共用同一决策, 保证音画同源
      const st = await liveResolveSrc(liveCh);
      liveIdx = st.idx;
      inputFile = st.src; biliHeaders = true;
      console.log(`[ws/frames] live ${liveCh} src#${st.idx}=${st.src}`);
    } catch (e) { try { ws.close(4004, 'live all sources failed: ' + e.message); } catch {} return; }
    if (clientGone) { console.log('[ws/frames] client gone during live resolve, abort'); return; }
  } else if (biliBv) {
    const t0 = Date.now();
    try { const urls = await getStreamUrls(biliBv); inputFile = urls.videoUrl; biliHeaders = true; console.log(`[ws/frames] getStreamUrls(${biliBv}) ${Date.now() - t0}ms`); }
    catch (e) { try { ws.close(4002, 'bili stream error: ' + e.message); } catch {} return; }
    if (clientGone) { console.log('[ws/frames] client gone during bili resolve, abort'); return; }
  } else if (ytId) {
    // YouTube：走「yt-dlp 取流 → 管道喂 ffmpeg」。
    // 不用直链的原因见文件内 youtube.js 注释第 5/6 条：
    //   默认 ANDROID_VR 客户端的直链要求 Range 头，ffmpeg 拉不动（403）；
    //   让 yt-dlp 自己取流写 stdout 最稳。
    ytPipe = true;
    console.log(`[ws/frames] youtube ${ytId} (pipe 模式)`);
  } else if (fileParam) {
    const resolved = safeVideoPath(fileParam);
    if (!resolved) { try { ws.close(4000, 'bad file'); } catch {} return; }
    if (!existsSync(resolved)) { try { ws.close(4001, 'file not found'); } catch {} return; }
    inputFile = resolved;
  }

  const args = ['-y'];
  if (biliHeaders) {
    args.push('-headers', liveCh ? LIVE_FFMPEG_HEADERS
      : 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0');
  }
  // YouTube 直链不需要 Referer，但带 UA 更稳（部分 CDN 节点会挑 UA）
  if (ytHeaders) {
    args.push('-headers', 'User-Agent: Mozilla/5.0\r\n');
  }
  // 直播源本身已是实时流: -re 会人为按片长限速读入, 叠加网络抖动就会缓冲耗尽 -> 卡顿/音频停摆。
  // 仅对点播文件/B站回放使用 -re; 直播改用低延迟输入标志。
  // YouTube 管道输入不用 -re：yt-dlp 已按网络速度喂数据，
  // 对 pipe 加 -re 行为不稳定（实测会拉长首帧甚至卡住）。
  if (!liveCh && !ytPipe) {
    args.push('-re');
  } else if (liveCh) {
    args.push('-fflags', 'nobuffer+discardcorrupt', '-flags', 'low_delay');
  }
  if (loop && !liveCh && !ytPipe) args.push('-stream_loop', '-1');
  // ytPipe 模式**不能**用 ffmpeg -ss：ffmpeg 无法对 pipe 输入 seek，
  // 加了会被忽略/从 0 重来。seek 交给 yt-dlp 的 --download-sections（见下）。
  if (seek > 0 && !liveCh && !ytPipe) args.push('-ss', String(seek));
  // 尺寸必须取偶: yuv420p 色度下采样要求宽高都能被 2 整除, 奇数尺寸会让滤镜直接失败。
  // 实测 pad=360:203 -> 输出 0 字节, pad=360:202 -> 266020 字节。
  // 客户端档位是**可控输入**(URL 参数), 服务端必须自己兜底。
  const w2 = Math.max(2, w - (w % 2));
  const h2 = Math.max(2, h - (h % 2));
  if (w2 !== w || h2 !== h) console.warn(`[ws/frames] 尺寸取偶 ${w}x${h} -> ${w2}x${h2}`);
  // 一律不用 pad。pad 带来两类"输入稍异常就整路 0 帧"的故障:
  //   (a) 直播源首帧报 0x0 时无法重建滤镜图;
  //   (b) 目标尺寸为奇数时 yuv420p 无法表示。
  // 客户端 drawDecoded 本来就等比缩放并居中留黑边, 服务端不需要 pad。
  // ytPipe 模式额外加 showinfo：把每帧真实 PTS 打到 stderr，
  // 供服务端作为帧时间戳（管道模式没有 -re 限速，计数方式会飙到上千秒）
  const vf = ytPipe
    ? `fps=${fps},showinfo,scale=${w2}:${h2}:force_original_aspect_ratio=decrease,setsar=1`
    : `fps=${fps},scale=${w2}:${h2}:force_original_aspect_ratio=decrease,setsar=1`;
  // YouTube 走 stdin 管道；其它来源照旧用 -i 文件/URL
  args.push('-i', ytPipe ? 'pipe:0' : inputFile, '-an', '-vf', vf,
    '-c:v', 'mjpeg', '-q:v', String(q), '-f', 'image2pipe', 'pipe:1');

  let buffer = Buffer.alloc(0);
  const tSpawn0 = Date.now();
  let firstSentAt = 0;
  let framesSent = 0;
  // 前端用文本帧告知「本路画面取自哪个源」, 车机上可直接核对音画是否同源
  if (liveCh) {
    try {
      const chan = liveChan(liveCh);
      ws.send(JSON.stringify({
        type: 'src', ch: liveCh, idx: liveIdx, src: inputFile,
        total: chan ? chan.srcs.length : 0, ts: Date.now()
      }), { binary: false });
    } catch {}
  }
  // 最后一道闸：到这一步客户端可能已经走了
  if (clientGone || ws.readyState !== 1) {
    console.log('[ws/frames] client gone before spawn, skip ffmpeg');
    return;
  }
  // YouTube：ffmpeg 的 stdin 要接管道（spawnTracked 默认是 ignore）
  const spawnOpts = ytPipe ? { stdio: ['pipe', 'pipe', 'pipe'] } : {};
  const proc = spawnTracked(args, spawnOpts, `ws-frames:${fileParam || biliBv || ytId || 'test'}`);

  // 启动 yt-dlp 并把 stdout 接到 ffmpeg 的 stdin。
  // 必须同时跟踪它：客户端断开/ffmpeg 退出时要一起杀，否则会继续下载。
  let ytProc = null;
  if (ytPipe) {
    const { spawn: spawnRaw } = await import('child_process');
    // seek：必须由 yt-dlp 在数据源一侧完成（pipe 无法 seek）
    const ytArgs = [
      '--no-warnings', '--no-playlist',
      '--extractor-args', 'youtube:player_client=android',
      '-f', 'best[height<=720]/best',
      '-S', 'vcodec:h264,res:720',
    ];
    if (seek > 0) {
      // "*<秒>-inf"：从该时间点取到结尾
      ytArgs.push('--download-sections', `*${Math.floor(seek)}-inf`);
      ytArgs.push('--force-keyframes-at-cuts');
      console.log(`[ws/frames] youtube seek -> ${Math.floor(seek)}s (由 yt-dlp 处理)`);
    }
    ytArgs.push('-o', '-', `https://www.youtube.com/watch?v=${ytId}`);
    ytProc = spawnRaw('yt-dlp', ytArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let ytErr = '';
    ytProc.stderr.on('data', (d) => { ytErr = (ytErr + d.toString()).slice(-400); });
    ytProc.stdout.pipe(proc.stdin);

    ytProc.on('error', (e) => {
      console.error('[ws/frames] yt-dlp spawn error', e.message);
      try { proc.stdin.end(); } catch {}
    });
    ytProc.on('close', (code) => {
      if (code !== 0) console.warn(`[ws/frames] yt-dlp exited ${code}: ${ytErr.slice(-200)}`);
      // yt-dlp 正常结束也要关掉 ffmpeg 的 stdin，让它收尾出完剩余帧
      try { proc.stdin.end(); } catch {}
    });
    // ffmpeg 先退出时，别让 yt-dlp 继续下载
    proc.on('close', () => { try { ytProc && ytProc.kill('SIGKILL'); } catch {} });
    proc.on('error', () => { try { ytProc && ytProc.kill('SIGKILL'); } catch {} });
  }
  // 首帧超时兜底: 客户端自己有 18s 慢源提示并会主动换源, 这里是兜底 ——
  // 老客户端/客户端未响应时也能自愈: 杀进程 -> ws 关闭 -> 客户端重连 -> 重新选源。
  let firstFrameTimer = 0;
  if (liveCh) {
    firstFrameTimer = setTimeout(() => {
      if (framesSent > 0) return;
      const n = (liveTimeoutStreak.get(liveCh) || 0) + 1;
      liveTimeoutStreak.set(liveCh, n);
      const aliveMs = Date.now() - tSpawn0;
      console.warn(`[ws/frames] live ${liveCh} 源#${liveIdx} 首帧超时 ${aliveMs}ms (连续 ${n} 次) -> 杀进程`
        + (n <= 3 ? '并作废源决策' : '(连续超时, 不再作废决策以免反复重探)'));
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'srcfail', ch: liveCh, idx: liveIdx, frames: 0, aliveMs, reason: 'slow' }), { binary: false });
      } catch {}
      if (n <= 3) liveSrcState.delete(liveCh);
      try { proc.kill('SIGKILL'); } catch {}
    }, LIVE_FIRST_FRAME_TIMEOUT_MS);
  }
  let stderr = '';
  /* ytPipe：从 stderr 的 showinfo 行里收集每帧 PTS，作为帧时间戳。
     showinfo 每个输入帧输出一行，顺序与 stdout 的 JPEG 帧一致。
     用队列与帧一一配对；若队列为空（例如 showinfo 尚未输出），
     回退到按 1/fps 递增，保证不会错位太多。 */
  const ptsQueue = [];
  let ptsParseTail = '';
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    stderr += s;
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
    if (!ytPipe) return;
    ptsParseTail += s;
    // showinfo 行形如：... pts_time:12.345 ...
    const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
    let m;
    while ((m = re.exec(ptsParseTail)) !== null) {
      ptsQueue.push(parseFloat(m[1]));
    }
    // 只保留最后一段，避免重复解析
    const lastNl = ptsParseTail.lastIndexOf('\n');
    if (lastNl >= 0) ptsParseTail = ptsParseTail.slice(lastNl + 1);
    if (ptsQueue.length > 4000) ptsQueue.splice(0, ptsQueue.length - 4000);
  });

  const JpegEnd = Buffer.from([0xFF, 0xD9]);
  let frameT = seek;
  // ytPipe 节流基准时刻（首次发送时确定）
  let ytStartAt = 0;
  // ytPipe 背压状态
  let throttlePaused = false;
  let throttleTimer = null;
  const THROTTLE_LEAD_MS = 600;   // 允许领先的毫秒数（约 0.6 秒画面）
  proc.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const start = buffer.indexOf(0xFF);
      if (start < 0) { buffer = Buffer.alloc(0); break; }
      if (start + 1 >= buffer.length) { buffer = buffer.slice(start); break; }
      if (buffer[start + 1] !== 0xD8) { buffer = buffer.slice(start + 1); continue; }
      const end = buffer.indexOf(JpegEnd, start + 2);
      if (end < 0) { buffer = buffer.slice(start); break; }
      const frame = buffer.slice(start, end + 2);
      buffer = buffer.slice(end + 2);
      // ytPipe：优先用真实 PTS；取不到则退回计数
      let stamp;
      if (ytPipe && ptsQueue.length) {
        stamp = ptsQueue.shift();
        frameT = stamp + 1 / fps;      // 保持 frameT 大致同步，供回退使用
      } else {
        stamp = frameT;
        frameT += 1 / fps;
      }
      // 时间戳必须有限且非负，否则 writeUInt32LE 会静默写 0
      if (!Number.isFinite(stamp) || stamp < 0) stamp = 0;
      if (ws.readyState !== 1 || ws.bufferedAmount > 16 * 1024 * 1024) continue;
      if (ytPipe && !ytStartAt) ytStartAt = Date.now();
      if (!firstSentAt) {
        firstSentAt = Date.now();
        if (firstFrameTimer) { clearTimeout(firstFrameTimer); firstFrameTimer = 0; }
        liveTimeoutStreak.delete(liveCh);
        console.log(`[ws/frames] first frame +${Date.now() - tSpawn0}ms`);
      }
      /* ytPipe 限速：用**流背压**让 ffmpeg 自己慢下来。
         YouTube 管道模式无法用 ffmpeg -re（对 pipe 不可用），ffmpeg 会以
         6~7 倍速解码；若立即转发，客户端缓冲瞬间填满、不断丢帧，画面永远
         超前音频 → 有声音无画面。

         做法：按"第 N 帧应在 start + N/fps 时刻发出"判断是否领先。
         领先超过阈值就 pause() ffmpeg 的 stdout —— 管道写满后 ffmpeg 会
         自然阻塞，解码速率随之降到实时；到点再 resume()。
         这比 setTimeout 排队可靠得多（排队会让成千上万个回调同时触发，
         反而制造突发流量 —— 实测正是如此）。 */
      const head = Buffer.alloc(4);
      head.writeUInt32LE(Math.min(0xFFFFFFF, Math.round(stamp * 1000)));
      if (ytPipe) {
        const due = ytStartAt + (framesSent * 1000) / fps;
        const lead = due - Date.now();
        if (lead > THROTTLE_LEAD_MS) {
          // 本帧仍然立即发（保持画面连续），但暂停上游，让它慢下来
          if (!throttlePaused) {
            throttlePaused = true;
            try { proc.stdout.pause(); } catch {}
          }
          if (!throttleTimer) {
            throttleTimer = setTimeout(() => {
              throttleTimer = null;
              throttlePaused = false;
              try { proc.stdout.resume(); } catch {}
            }, Math.min(lead, 5000));
          }
        } else if (throttlePaused && !throttleTimer) {
          throttlePaused = false;
          try { proc.stdout.resume(); } catch {}
        }
      }
      framesSent++;
      ws.send(Buffer.concat([head, frame]), { binary: true });
    }
  });

  ws.on('message', (raw) => {
    let ctrl = null;
    try { ctrl = JSON.parse(String(raw)); } catch {}
    if (ctrl?.type === 'pause') { holdProc(proc); proc.stdout.pause(); }
    else if (ctrl?.type === 'resume') { touchProc(proc); proc.stdout.resume(); }
  });

  ws.on('close', () => { killProc(proc); try { ytProc && ytProc.kill('SIGKILL'); } catch {} });
  ws.on('error', () => { killProc(proc); try { ytProc && ytProc.kill('SIGKILL'); } catch {} });
  proc.on('close', (code, signal) => {
    if (firstFrameTimer) { clearTimeout(firstFrameTimer); firstFrameTimer = 0; }
    if (code !== 0 && code !== null) console.error('[ws/frames] ffmpeg exited', code, stderr.slice(-300));
    // 直播源失败判定: 起播 12s 内自然退出(不是被我们 SIGKILL 掉的) => 该源不可用, 记账
    // 否则坏源会被永久缓存, 客户端重连永远拿到同一个坏源。
    if (liveCh && liveIdx >= 0 && signal !== 'SIGKILL') {
      const aliveMs = Date.now() - tSpawn0;
      if (framesSent === 0 || aliveMs < 12000) {
        console.warn(`[ws/frames] live ${liveCh} 源#${liveIdx} 失败 frames=${framesSent} alive=${aliveMs}ms code=${code} sig=${signal} :: ${stderr.slice(-200)}`);
        liveSrcPenalize(liveCh, liveIdx);
        try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'srcfail', ch: liveCh, idx: liveIdx, frames: framesSent, aliveMs }), { binary: false }); } catch {}
      }
    }
    try { ws.close(); } catch {}
  });
  console.log(`[ws/frames] fps=${fps} ${w}x${h} q=${q} file=${fileParam || 'test'} live=${liveCh || ''} seek=${seek}`);
}

function handleMpeg1(ws, url) {
  const vb = parseInt(url.searchParams.get('vb') || '1000', 10);
  const h = Math.min(720, parseInt(url.searchParams.get('h') || '540', 10));
  const w = Math.min(1280, parseInt(url.searchParams.get('w') || '960', 10));
  const loop = url.searchParams.get('loop') !== '0';
  // 加固 v2 (S15): parseFloat 失败会得到 NaN，而 writeUInt32LE(NaN) 会静默
  // 写 0 → 所有帧时间戳归零（画面时间轴失效）。这里兜底为 0。
  let seek = parseFloat(url.searchParams.get('seek') || '0');
  if (!Number.isFinite(seek) || seek < 0) seek = 0;
  const fileParam = url.searchParams.get('file');

  let inputFile = TEST_CLIP;
  if (fileParam) {
    const resolved = safeVideoPath(fileParam);
    if (!resolved) { try { ws.close(4000, 'bad file'); } catch {} return; }
    if (!existsSync(resolved)) { try { ws.close(4001, 'file not found'); } catch {} return; }
    inputFile = resolved;
  }

  const args = ['-y'];
  if (loop) args.push('-stream_loop', '-1');
  if (seek > 0) args.push('-ss', String(seek));
  args.push('-i', inputFile, '-c:v', 'mpeg1video', '-b:v', `${vb}k`, '-s', `${w}x${h}`, '-c:a', 'mp2', '-b:a', '96k', '-f', 'mpegts', 'pipe:1');

  const proc = spawnTracked(args, {}, `ws-mpeg1:${fileParam || 'test'}`);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 2000) stderr = stderr.slice(-2000); });
  proc.stdout.on('data', (chunk) => { if (ws.readyState === 1) ws.send(chunk, { binary: true }); });
  ws.on('close', () => killProc(proc));
  ws.on('error', () => killProc(proc));
  proc.on('close', (code) => { if (code !== 0) console.error('[ws/mpeg1] ffmpeg exited', code, stderr.slice(-300)); try { ws.close(); } catch {} });
}

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
  if (url.pathname === '/ws/frames') wss.handleUpgrade(req, socket, head, (ws) => handleFrames(ws, url));
  else if (url.pathname === '/ws/mpeg1') wss.handleUpgrade(req, socket, head, (ws) => handleMpeg1(ws, url));
  else { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); }
});

// ─── API: Debug / Version / Cleanup ───────────────────────────────────
// 客户端日志上报。该端点暴露在公网（车机走公网回连），必须硬化，否则可被写满磁盘。
const DEBUG_LOG_PATH = join(__dirname, 'debug.log');
const DEBUG_LOG_KEY = process.env.DEBUG_LOG_KEY || '';   // 非空则强制 key 校验（见 DEV.md 0V 节）
const DEBUG_LOG_MAX_BODY = 64 * 1024;                    // 单次上报体上限 64KB
const DEBUG_LOG_RATE_MS = 5 * 60 * 1000;                 // 限流窗口 5 分钟
const DEBUG_LOG_RATE_MAX = 240;                          // 每 IP 每窗口上限（客户端实测 ~15 次/5min）
const DEBUG_LOG_MAX_BYTES = (parseFloat(process.env.DEBUG_LOG_MAX_MB || '20')) * 1024 * 1024;  // 单文件上限
let debugLogBytes = 0;                                   // 当前 debug.log 字节数（启动时读一次，之后自增）
try { debugLogBytes = statSync(DEBUG_LOG_PATH).size; } catch {}
const debugLogHits = new Map();                          // ip -> 时间戳数组

function debugLogClientIp(req) {
  const raw = req.ip || req.socket.remoteAddress || '?';
  // 若在反代后面（来源是 loopback），退化用 XFF 首段；否则所有请求会被算成同一个 IP 而整体限流
  if (raw === '::1' || raw === '127.0.0.1' || raw === '::ffff:127.0.0.1') {
    const xf = (req.get('x-forwarded-for') || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return raw;
}

function debugLogRateLimited(ip) {
  const now = Date.now();
  let arr = debugLogHits.get(ip);
  if (!arr) { arr = []; debugLogHits.set(ip, arr); }
  while (arr.length && now - arr[0] > DEBUG_LOG_RATE_MS) arr.shift();
  if (arr.length >= DEBUG_LOG_RATE_MAX) return true;
  arr.push(now);
  return false;
}

// 限流表兜底清理，防内存无界增长（每窗口扫一次）
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of debugLogHits) {
    while (arr.length && now - arr[0] > DEBUG_LOG_RATE_MS) arr.shift();
    if (!arr.length) debugLogHits.delete(ip);
  }
}, DEBUG_LOG_RATE_MS).unref();

// 大小上限 + 单代轮转：debug.log 只保留一代（debug.log.1）。
// 没有这层，公网端点迟早把磁盘写满（原先 debug.log 无任何上限、无轮转，实测已约 1MB）。
// 用字节计数而非每次 statSync，避免每条上报都多一次 syscall。
function debugLogRotateIfNeeded() {
  if (debugLogBytes <= DEBUG_LOG_MAX_BYTES) return false;
  try {
    renameSync(DEBUG_LOG_PATH, DEBUG_LOG_PATH + '.1');
    debugLogBytes = 0;
    console.log(`[debug-log] rotated at ${(DEBUG_LOG_MAX_BYTES / 1024 / 1024).toFixed(1)}MB`);
    return true;
  } catch (e) { console.warn('[debug-log] rotate failed:', e.message); return false; }
}

// 同源校验：真实客户端是浏览器，POST 必带 Origin 或 Sec-Fetch-Site（页面脚本无法伪造）；
// 盲扫/爬虫通常两者都不带 —— 这是拦掉绝大多数滥用最省事的一层。
// 需要更强鉴权时设 DEBUG_LOG_KEY，并在页面 URL 上带 ?key=（见 DEV.md 0V 节）。
function debugLogAllowed(req) {
  if (DEBUG_LOG_KEY) return (req.get('x-debug-key') || req.query.key || '') === DEBUG_LOG_KEY;
  const sfs = req.get('sec-fetch-site');
  if (sfs === 'same-origin' || sfs === 'same-site') return true;
  const host = req.get('host');
  for (const h of ['origin', 'referer']) {
    const v = req.get(h);
    if (!v) continue;
    try { if (new URL(v).host === host) return true; } catch {}
  }
  return false;
}

app.post('/api/debug-log', async (req, res) => {
  if (!debugLogAllowed(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (debugLogRateLimited(debugLogClientIp(req))) return res.status(429).json({ ok: false, error: 'rate limited' });
  const line = JSON.stringify({ receivedAt: new Date().toISOString(), ...req.body });
  if (line.length > DEBUG_LOG_MAX_BODY) return res.status(413).json({ ok: false, error: 'too large' });
  try {
    debugLogRotateIfNeeded();
    await appendFile(DEBUG_LOG_PATH, line + '\n');
    debugLogBytes += Buffer.byteLength(line) + 1;
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

let gitVersion = 'unknown';
execFile('git', ['describe', '--tags', '--always', '--dirty'], { cwd: __dirname, timeout: 5000 }, (err, stdout) => { if (!err) gitVersion = stdout.trim(); });
app.get('/api/version', (req, res) => { res.json({ version: gitVersion }); });

// mic-log 限流：与 debug-log 同构（每 IP 每 5 分钟 120 次）
const micLogRate = new Map();
function micLogRateOk(req) {
  const ip = debugLogClientIp(req);
  const now = Date.now();
  const win = 5 * 60 * 1000;
  const rec = micLogRate.get(ip) || { n: 0, t: now };
  if (now - rec.t > win) { rec.n = 0; rec.t = now; }
  rec.n++;
  micLogRate.set(ip, rec);
  if (micLogRate.size > 500) {
    for (const [k, v] of micLogRate) if (now - v.t > win) micLogRate.delete(k);
  }
  return rec.n <= 120;
}

// /api/live/:ch/seg 只允许该频道已解析出的最终 URL 及其同源片段
function liveSegUrlAllowed(ch, u) {
  if (!u) return false;
  const st = liveSrcState.get(ch);
  const base = st && st.src ? st.src : null;
  if (!base) return false;
  try {
    const a = new URL(String(u));
    const b = new URL(base);
    return a.host === b.host;
  } catch { return false; }
}

app.post('/api/cleanup', (req, res) => {
  // 加固 v2 (S6): 原实现无鉴权且执行 host 级 `pkill -9 -f ffmpeg`，任何能访问
  // 到端口的人都能远程杀掉机器上所有 ffmpeg（含与本服务无关的）。公网可达。
  // 现在：① 要求同源（浏览器 POST 必带 Origin/Sec-Fetch-Site）；② 只杀本
  // 进程注册表内的 ffmpeg；③ 可选 CLEANUP_KEY 强鉴权。
  if (!debugLogAllowed(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const needKey = process.env.CLEANUP_KEY;
  if (needKey && req.get('x-cleanup-key') !== needKey) {
    return res.status(401).json({ ok: false, error: 'bad key' });
  }
  // 加固 v2 (S6): 不再执行 host 级 `pkill -9 -f ffmpeg`（会误杀与本服务无关的
  // ffmpeg，且对公网可达的端点来说等于远程 DoS）。cleanupAllFfmpeg() 已覆盖
  // 本服务注册表内的全部进程；before 仅作参考上报。
  exec("ps -eo pid,cmd | grep -E '[f]fmpeg' | wc -l", (e1, before) => {
    const local = cleanupAllFfmpeg();
    const total = (parseInt(before || '0', 10) || 0);
    res.json({ ok: true, killedBefore: local, seenBefore: total });
    console.log(`[cleanup] killed ${local} tracked ffmpeg (host had ${total})`);
  });
});

// ─── API: Public IP ───────────────────────────────────────────────────
let cachedPublicIp = null;
let publicIpTs = 0;
async function getPublicIp(force) {
  if (!force && cachedPublicIp && Date.now() - publicIpTs < 300000) return cachedPublicIp;
  for (const u of ['https://ifconfig.me/ip', 'https://icanhazip.com', 'https://api.ipify.org', 'https://checkip.amazonaws.com']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(u, { signal: ctrl.signal });
      clearTimeout(timer);
      const ip = (await r.text()).trim().split(/\s+/)[0];
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { cachedPublicIp = ip; publicIpTs = Date.now(); return ip; }
    } catch {}
  }
  return cachedPublicIp || null;
}
app.get('/api/public-ip', async (req, res) => {
  try { if (req.query.refresh) publicIpTs = 0; const ip = await getPublicIp(!!req.query.refresh); res.json({ ip, at: publicIpTs || null, cached: !!cachedPublicIp && !req.query.refresh }); }
  catch { res.json({ ip: null, at: null }); }
});

// ─── API: Video List / Stream / Segments / Audio / Duration ───────────
app.get('/api/videos', async (req, res) => {
  try {
    const files = await readdir(VIDEOS_DIR);
    const entries = await Promise.all(files.map(async (file) => {
      if (file.startsWith('.')) return null;
      if (!VIDEO_EXTS.has(extname(file).toLowerCase())) return null;
      try {
        const stats = await stat(join(VIDEOS_DIR, file));
        const codec = await getCodec(file);
        const job = transcodeJobs.get(file);
        const sj = segJobs.get(file);
        return { name: file, size: stats.size, codec, status: job ? job.status : (DIRECT_CODECS.has(codec) ? 'ready' : existsSync(cachePath(file)) ? 'ready' : 'queued'), needsTranscode: !DIRECT_CODECS.has(codec), segments: existsSync(segMetaPath(file)) ? 'ready' : (sj ? sj.status : null) };
      } catch { return null; }
    }));
    res.json(entries.filter(Boolean));
  } catch { res.json([]); }
});

app.get('/api/video/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..')) return res.status(400).json({ error: 'Bad filename' });
  if (req.query.status) {
    const path = await resolveVideoPath(filename, res);
    if (res.headersSent) return;
    return path ? res.json({ status: 'ready' }) : res.status(202).json({ status: 'transcoding' });
  }
  const filePath = await resolveVideoPath(filename, res);
  if (res.headersSent) return;
  if (!filePath || typeof filePath !== 'string') return res.status(202).json({ status: 'transcoding' });
  try {
    const stats = await stat(filePath);
    const fileSize = stats.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
      createReadStream(filePath).pipe(res);
    }
  } catch { res.status(404).json({ error: 'Video not found' }); }
});

app.get('/api/segments/:filename/meta.json', (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..')) return res.status(400).end();
  const mp = segMetaPath(filename);
  if (!existsSync(mp)) { ensureSegmentation(filename); return res.status(202).json({ status: 'segmenting' }); }
  touchSeg(filename);
  res.type('application/json').sendFile(mp);
});

app.get('/api/segments/:filename/:segfile', (req, res) => {
  const { filename, segfile } = req.params;
  if (!filename || filename.includes('..')) return res.status(400).end();
  if (!/^seg-\d{5}\.mp4$/.test(segfile)) return res.status(400).end();
  const p = join(segDir(filename), segfile);
  if (!existsSync(p)) return res.status(404).end();
  touchSeg(filename);
  res.sendFile(p);
});

app.get('/api/segments/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..')) return res.status(400).json({ error: 'bad filename' });
  if (existsSync(segMetaPath(filename))) { touchSeg(filename); return res.json({ status: 'ready' }); }
  ensureSegmentation(filename);
  const tj = transcodeJobs.get(filename);
  if (tj) return res.json({ status: tj.status === 'error' ? 'error' : tj.status });
  const sj = segJobs.get(filename);
  if (sj) return res.json({ status: sj.status === 'error' ? 'error' : sj.status });
  return res.json({ status: 'queued' });
});

app.get('/api/audio/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..')) return res.status(400).json({ error: 'bad filename' });
  const codec = await getCodec(filename);
  if (req.query.status) {
    if (DIRECT_CODECS.has(codec)) return res.json({ status: existsSync(audioCachePath(filename)) ? 'ready' : 'preparing' });
    if (existsSync(audioCachePath(filename))) { touchSeg(filename); return res.json({ status: 'ready' }); }
    ensureSegmentation(filename);
    const tj = transcodeJobs.get(filename);
    if (tj) return res.json({ status: tj.status === 'error' ? 'error' : tj.status });
    const sj = segJobs.get(filename);
    if (sj) return res.json({ status: sj.status === 'error' ? 'error' : sj.status });
    return res.json({ status: 'queued' });
  }
  if (DIRECT_CODECS.has(codec)) {
    const apc = audioCachePath(filename);
    if (existsSync(apc)) { touchSeg(filename); return res.sendFile(apc); }
    ensureSegmentation(filename); return res.redirect(302, `/api/video/${encodeURIComponent(filename)}`);
  }
  const ap = audioCachePath(filename);
  if (existsSync(ap)) { touchSeg(filename); return res.sendFile(ap); }
  ensureSegmentation(filename);
  return res.status(202).json({ status: 'preparing' });
});

app.get('/api/duration/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..')) return res.status(400).json({ error: 'bad filename' });
  const codec = await getCodec(filename);
  let filePath;
  if (DIRECT_CODECS.has(codec)) filePath = join(VIDEOS_DIR, filename);
  else { filePath = cachePath(filename); if (!existsSync(filePath)) filePath = join(VIDEOS_DIR, filename); }
  if (!existsSync(filePath)) return res.json({ duration: 0 });
  res.json({ duration: await ffprobeDuration(filePath) });
});

// ─── API: Subtitles / Lyrics / Music ──────────────────────────────────
app.get('/api/subtitles', async (req, res) => {
  try { const files = await readdir(SUBTITLES_DIR); res.json(files.filter(f => ['.srt', '.vtt', '.ass'].includes(extname(f).toLowerCase())).map(f => ({ name: f, path: `/subtitles/${f}` }))); }
  catch { res.json([]); }
});

app.get('/api/subtitle/:filename', async (req, res) => {
  // 安全修复: 必须与 /api/video/:filename 同级校验。此前直接
  // readFile(join(SUBTITLES_DIR, req.params.filename)), 未过滤 ".." / "/" / "\\",
  // 导致 /api/subtitle/..%2f..%2f..%2f..%2fetc%2fpasswd 可读取服务器任意文件;
  // 本服务经公网域名暴露, 已实测读出 /etc/passwd(路径穿越)。
  const filename = req.params.filename;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Bad filename' });
  }
  if (!['.srt', '.vtt', '.ass'].includes(extname(filename).toLowerCase())) {
    return res.status(400).json({ error: 'Bad extension' });
  }
  try { res.type('text/vtt').send(await readFile(join(SUBTITLES_DIR, filename), 'utf-8')); }
  catch { res.status(404).json({ error: 'Subtitle not found' }); }
});

app.get('/api/lyrics', async (req, res) => {
  try {
    const files = await readdir(LYRICS_DIR);
    const lrcs = files.filter(f => f.endsWith('.lrc'));
    res.json(await Promise.all(lrcs.map(async f => ({ name: f.replace(/\.lrc$/i, ''), content: await readFile(join(LYRICS_DIR, f), 'utf-8') }))));
  } catch { res.json([]); }
});

app.get('/api/music', async (req, res) => {
  try {
    const files = await readdir(MUSIC_DIR);
    const entries = [];
    for (const f of files) { if (f.startsWith('.')) continue; if (!MUSIC_EXTS.has(extname(f).toLowerCase())) continue; try { entries.push({ name: f, size: (await stat(join(MUSIC_DIR, f))).size }); } catch {} }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    res.json(entries);
  } catch { res.json([]); }
});

app.get('/api/music/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!name || name.includes('..') || name.includes('/')) return res.status(400).end();
  const filePath = join(MUSIC_DIR, name);
  try {
    const st = await stat(filePath);
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : st.size - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'audio/mpeg' });
      createReadStream(filePath, { start, end }).pipe(res);
    } else { res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'audio/mpeg' }); createReadStream(filePath).pipe(res); }
  } catch { res.status(404).end(); }
});

// ─── API: Thumbnails / Duration ───────────────────────────────────────
if (!existsSync(THUMB_DIR)) mkdirSync(THUMB_DIR, { recursive: true });

app.get("/api/video-thumb/:filename", async (req, res) => {
  const name = req.params.filename;
  if (!name || name.includes("..") || name.includes("/")) return res.status(400).send("bad");
  const videoPath = join(VIDEOS_DIR, name);
  if (!existsSync(videoPath)) return res.status(404).send("not found");
  const thumbPath = join(THUMB_DIR, name.replace(/\.[^.]+$/, '') + ".jpg");
  if (!existsSync(thumbPath)) {
    await new Promise((r) => { const ff = spawn("ffmpeg", ["-ss", "5", "-i", videoPath, "-vframes", "1", "-vf", "scale=320:-1", "-q:v", "5", "-y", thumbPath]); ff.on("close", r); ff.on("error", r); });
  }
  if (existsSync(thumbPath)) { res.setHeader("Content-Type", "image/jpeg"); res.setHeader("Cache-Control", "public, max-age=86400"); res.sendFile(thumbPath); }
  else res.status(500).send("thumb failed");
});

app.get("/api/video-duration/:filename", async (req, res) => {
  const name = req.params.filename;
  if (!name || name.includes("..")) return res.json({ duration: 0 });
  const videoPath = join(VIDEOS_DIR, name);
  const cacheFile = join(THUMB_DIR, name.replace(/\.[^.]+$/, "") + ".dur");
  if (existsSync(cacheFile)) return res.json({ duration: parseFloat(readFileSync(cacheFile, "utf8")) || 0 });
  try {
    const dur = await new Promise((resolve, reject) => {
      execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { timeout: 10000 }, (err, stdout) => err ? reject(err) : resolve(parseFloat(stdout.trim()) || 0));
    });
    writeFileSync(cacheFile, String(dur));
    res.json({ duration: dur });
  } catch { res.json({ duration: 0 }); }
});

// ─── API: Mic Test ────────────────────────────────────────────────────
if (!existsSync(MIC_LOG_DIR)) await mkdir(MIC_LOG_DIR, { recursive: true });
app.post('/api/mic-log', async (req, res) => {
  // 加固 v2 (S7): 与 0V 节给 debug-log 做的加固同构 —— 该端点公网可达，
  // 原先无鉴权、无限流、无大小上限，可被写满磁盘。
  if (!debugLogAllowed(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (!micLogRateOk(req)) return res.status(429).json({ ok: false, error: 'rate limited' });
  try { await appendFile(join(MIC_LOG_DIR, 'mic-test.log'), JSON.stringify({ ts: new Date().toISOString(), ...req.body }) + '\n'); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/mic-log', async (req, res) => {
  try { const data = await readFile(join(MIC_LOG_DIR, 'mic-test.log'), 'utf-8'); res.json({ logs: data.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return l; } }) }); }
  catch { res.json({ logs: [] }); }
});

// ─── API: Bilibili ────────────────────────────────────────────────────
import { parseBiliUrl, getBiliInfo, startDownload, getDownload, getAllDownloads, searchBili, getPopular, getRecommend, generateQR, getQRCode, clearQRCode, pollQR, isLoggedIn, logout, getStreamUrls, getFollowings, getFollowingVideos, getFavorites, getFavoriteVideos } from './bilibili.js';
import { searchYouTube, getYouTubeHot, getYouTubeInfo, getYouTubeDuration, getYouTubeStreamUrls, parseYouTubeId } from './youtube.js';

app.get('/api/bilibili/info', async (req, res) => {
  try { const p = parseBiliUrl(req.query.url || ''); if (!p) return res.json({ ok: false, error: 'invalid URL' }); res.json({ ok: true, ...(await getBiliInfo(p.bv)) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/bilibili/download', express.json(), async (req, res) => {
  try { const p = parseBiliUrl(req.body.url || ''); if (!p) return res.json({ ok: false, error: 'invalid URL' }); const s = startDownload(p.bv); res.json({ ok: true, id: s.id, bv: p.bv }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/bilibili/downloads', (req, res) => { res.json({ downloads: getAllDownloads().map(d => ({ id: d.id, bv: d.bv, title: d.title, status: d.status, progress: d.progress, error: d.error })) }); });
app.get('/api/bilibili/status', (req, res) => { const d = getDownload(req.query.id); d ? res.json({ ok: true, status: d.status, progress: d.progress, title: d.title, error: d.error }) : res.json({ ok: false }); });
app.get('/api/bilibili/search', async (req, res) => { try { res.json({ ok: true, ...(await searchBili(req.query.keyword || '', parseInt(req.query.page) || 1)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/bilibili/popular', async (req, res) => { try { res.json({ ok: true, ...(await getPopular(parseInt(req.query.page) || 1)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/bilibili/recommend', async (req, res) => { try { if (!isLoggedIn()) return res.json({ ok: false, error: 'not_logged_in', needLogin: true }); res.json({ ok: true, ...(await getRecommend(parseInt(req.query.fresh_idx) || 1)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/bilibili/qr', async (req, res) => { try { res.json({ ok: true, ...(await generateQR()) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/bilibili/qr/poll', async (req, res) => {
  try {
    const r = await pollQR(req.query.key);
    // 登录成功：清掉二维码缓存，下次登录会生成新的
    if (r && r.status === 'success') clearQRCode();
    res.json({ ok: true, ...r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/bilibili/login-status', (req, res) => { res.json({ ok: true, loggedIn: isLoggedIn() }); });
app.get('/api/bilibili/followings', async (req, res) => { try { if (!isLoggedIn()) return res.json({ ok: false, needLogin: true }); res.json({ ok: true, ...(await getFollowings(parseInt(req.query.pn) || 1)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/bilibili/following/videos', async (req, res) => { try { if (!isLoggedIn()) return res.json({ ok: false, needLogin: true }); res.json({ ok: true, ...(await getFollowingVideos(req.query.uid, parseInt(req.query.pn) || 1)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/bilibili/favorites', async (req, res) => { try { if (!isLoggedIn()) return res.json({ ok: false, needLogin: true }); res.json({ ok: true, ...(await getFavorites()) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/bilibili/favorites/videos', async (req, res) => { try { if (!isLoggedIn()) return res.json({ ok: false, needLogin: true }); res.json({ ok: true, ...(await getFavoriteVideos(req.query.fid, parseInt(req.query.pn) || 1)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/bilibili/logout', (req, res) => { logout(); clearQRCode(); res.json({ ok: true }); });
app.get('/api/bilibili/qr/meta', async (req, res) => {
  // 用带缓存的 getQRCode：必须与 /qr/image 拿到同一个二维码，
  // 否则"扫的码"与"轮询的 key"不一致 → 扫码没反应（实测根因）。
  // ?refresh=1 强制刷新（前端"二维码过期，重新获取"用）。
  try {
    const qr = await getQRCode({ force: req.query.refresh === '1' });
    res.json({ ok: true, qrcode_key: qr.qrcode_key });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/bilibili/qr/image', async (req, res) => {
  // 与 /qr/meta 共用缓存中的同一个二维码（关键修复）
  try {
    const qr = await getQRCode();
    const QRCode = (await import('qrcode')).default;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(await QRCode.toBuffer(qr.qr_url, { width: 260, margin: 2 }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── API: YouTube ─────────────────────────────────────────────────────
// 与 B站 同构。注意：YouTube 直链带签名且绑定请求方 IP，**不能**直接发给
// 浏览器（IP 不同会 403），所以画面走 /ws/frames 的 ?yt= 分支、
// 音频走服务端转码。这一点与 B站 的做法完全一致。

const YT_AUDIO_TMP = '/tmp/yt_audio';

app.get('/api/youtube/search', async (req, res) => {
  try {
    const kw = req.query.keyword || '';
    const limit = parseInt(req.query.limit) || 20;
    res.json({ ok: true, ...(await searchYouTube(kw, limit)) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/youtube/hot', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json({ ok: true, ...(await getYouTubeHot(limit)) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/youtube/info', async (req, res) => {
  try { res.json({ ok: true, ...(await getYouTubeInfo(req.query.id || req.query.url)) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/youtube/duration/:id', async (req, res) => {
  try {
    const safe = parseYouTubeId(req.params.id);
    if (!safe) return res.status(400).json({ error: 'bad id' });
    res.json({ ok: true, ...(await getYouTubeDuration(safe)) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 缩略图代理：YouTube 缩略图域名固定，白名单校验后转发
app.get('/api/youtube/img-proxy', async (req, res) => {
  let raw = String(req.query.url || '').trim();
  if (raw.startsWith('//')) raw = 'https:' + raw;
  let ok = false;
  try {
    const h = new URL(raw).hostname.toLowerCase();
    ok = h === 'ytimg.com' || h.endsWith('.ytimg.com')
      || h === 'ggpht.com' || h.endsWith('.ggpht.com')
      || h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com');
  } catch { ok = false; }
  if (!ok) return res.status(403).end();
  try {
    const r = await fetch(raw, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

// 音频：ffmpeg 从 YouTube 直链抽 mp3，落盘后支持 Range 拖动。
// 与 B站 的 /audio-file 同构（含 .part + rename 原子写，避免半成品被读到）。
const ytAudioJobs = new Map();       // id -> { ff, yt, part, file, listeners:Set }
function ytAudioCachePath(id) { return join(YT_AUDIO_TMP, id + '.mp3'); }

/**
 * 启动（或复用）一个 YouTube 音频转码任务。
 *
 * 与旧实现的关键区别：
 *   · 用 `yt-dlp -o - | ffmpeg -i pipe:0`，不再解析直链（直链对请求方式敏感，
 *     且解析本身要 5~15s）。
 *   · 返回的 ff 进程**立即**开始产出，调用方可以马上把 stdout 转给响应，
 *     首字节从 30~60s 降到几秒。
 *   · 输出同时写入 .part，完成后原子 rename 成正式缓存 —— 首次播放立刻有声，
 *     后续请求命中缓存并支持 Range 拖动。
 */
function getYtAudioJob(id) {
  if (ytAudioJobs.has(id)) return ytAudioJobs.get(id);

  const file = ytAudioCachePath(id);
  const part = file + '.part';
  try { mkdirSync(YT_AUDIO_TMP, { recursive: true }); } catch {}
  try { unlinkSync(part); } catch {}

  // yt-dlp：只取音轨，输出到 stdout
  const yt = spawnRaw('yt-dlp', [
    '--no-warnings', '--no-playlist',
    '--extractor-args', 'youtube:player_client=android',
    '-f', 'bestaudio/best',
    '-o', '-',
    `https://www.youtube.com/watch?v=${id}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // ffmpeg：从 stdin 解码，输出 mp3 到 stdout
  const ff = spawnTracked([
    '-i', 'pipe:0',
    '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] }, 'yt-audio:' + id);

  let ytErr = '';
  yt.stderr.on('data', (d) => { ytErr = (ytErr + d.toString()).slice(-400); });
  ff.stderr.on('data', () => {});
  yt.stdout.pipe(ff.stdin);

  // 并行落盘（转码完成后原子替换）
  const ws = createWriteStream(part);
  ff.stdout.pipe(ws, { end: true });

  const job = { ff, yt, part, file, listeners: new Set(), done: false };

  yt.on('error', (e) => { console.error('[yt-audio] yt-dlp error', e.message); try { ff.stdin.end(); } catch {} });
  yt.on('close', (code) => {
    if (code !== 0) console.warn(`[yt-audio] yt-dlp exited ${code}: ${ytErr.slice(-200)}`);
    try { ff.stdin.end(); } catch {}
  });
  ff.on('error', () => { try { yt.kill('SIGKILL'); } catch {} });

  ff.on('close', (code) => {
    job.done = true;
    ws.end(() => {
      if (code === 0) { try { renameSync(part, file); console.log(`[yt-audio] ${id} 已缓存`); } catch {} }
      else { try { unlinkSync(part); } catch {} }
    });
    try { yt.kill('SIGKILL'); } catch {}
    // 任务结束后从表里移除，下次请求走缓存
    setTimeout(() => ytAudioJobs.delete(id), 1000);
  });

  ytAudioJobs.set(id, job);
  return job;
}

app.get('/api/youtube/audio-file/:id', async (req, res) => {
  const id = parseYouTubeId(req.params.id);
  if (!id) return res.status(400).send('bad id');

  const file = ytAudioCachePath(id);
  // 已缓存：直接送文件（支持 Range 拖动，与 B站 一致）
  if (existsSync(file)) {
    return res.sendFile(file, { maxAge: '30d', headers: { 'Accept-Ranges': 'bytes' } });
  }

  let job;
  try { job = getYtAudioJob(id); }
  catch (e) { return res.status(500).send((e && e.message) || 'audio fail'); }

  // 边转码边发送：不等整个文件转完，首字节几秒内就到
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  if (res.flushHeaders) res.flushHeaders();

  const onData = (d) => { try { res.write(d); } catch {} };
  const onEnd = () => { try { res.end(); } catch {} };
  const cleanup = () => {
    job.ff.stdout.removeListener('data', onData);
    job.ff.stdout.removeListener('end', onEnd);
    job.listeners.delete(cleanup);
  };

  job.ff.stdout.on('data', onData);
  job.ff.stdout.on('end', onEnd);
  job.listeners.add(cleanup);

  // 转码已完成但文件刚 rename（竞态）：补一次缓存投递
  job.ff.on('close', () => {
    cleanup();
    try { res.end(); } catch {}
  });
  req.on('close', cleanup);
});

app.get("/api/bilibili/img-proxy", async (req, res) => {
  // 加固 v2 (S9): 原白名单是"URL 字符串里包含 hdslb.com"，于是
  // http://evil.example/?hdslb.com 也能通过。改为解析出 host 再比对后缀。
  {
    let ok = false;
    try {
      // 注意：B站搜索接口返回的 pic 是**协议相对 URL**（//host/path），
      // 直接 new URL() 会抛错而被判为非法 → 频道图片全挂。这里先补协议。
      let raw = String(req.query.url || '').trim();
      if (raw.startsWith('//')) raw = 'https:' + raw;
      const h = new URL(raw).hostname.toLowerCase();
      ok = h === 'hdslb.com' || h.endsWith('.hdslb.com')
        || h === 'biliimg.com' || h.endsWith('.biliimg.com');
    } catch { ok = false; }
    if (!ok) return res.status(403).end();
  }
  try {
    const url = req.query.url;
    if (!url || (!url.includes("hdslb.com") && !url.includes("biliimg.com"))) return res.status(400).send("invalid url");
    const resp = await fetch(url.startsWith("//") ? "https:" + url : url, { headers: { "Referer": "https://www.bilibili.com/", "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return res.status(resp.status).send("fetch failed");
    res.setHeader("Content-Type", resp.headers.get("content-type") || "image/jpeg").setHeader("Cache-Control", "public, max-age=86400").send(Buffer.from(await resp.arrayBuffer()));
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/api/bilibili/play/:bv", async (req, res) => { try { res.json({ ok: true, ...(await getStreamUrls(req.params.bv)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });

app.get("/api/bilibili/audio/:bv", async (req, res) => {
  try {
    const bv = req.params.bv;
    const seek = parseFloat(req.query.seek || "0");
    const urls = await getStreamUrls(bv);
    if (!urls.audioUrl) return res.status(404).send("no audio");
    const a = ["-headers", "Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0"];
    if (seek > 0) a.push("-ss", String(seek));
    a.push("-i", urls.audioUrl, "-ar", "44100", "-ac", "2", "-f", "wav", "pipe:1");
    // 必须走 spawnTracked（而非裸 spawn）：裸 spawn 的进程不进 ffmpegProcs 注册表，
    // /api/cleanup 与退出时的 cleanupAllFfmpeg 都扫不到它 —— 0H 节记录的 12 个残留
    // ffmpeg 僵尸（约 660MB）就是这条路径漏的。4h 超时兜底：B站 CDN URL 过期后
    // ffmpeg 会卡在无限等待，既不退出也不产数据。
    const ff = spawnTracked(a, { timeout: 4 * 3600 * 1000 }, 'bili-audio-stream:' + bv);
    res.setHeader("Content-Type", "audio/wav").setHeader("Transfer-Encoding", "chunked");
    ff.stdout.pipe(res);
    ff.stderr.on("data", () => {});
    // 清理三路兜底 + killed 标志防重复触发：
    // 只挂 req.on('close') 在 QtWebEngine 断流时不可靠（0H 节事故根因），需补 res.on('close')；
    // ff 自然退出/报错时也要收尾，否则响应悬挂、进程残留。
    let killed = false;
    const endRes = () => { try { if (!res.writableEnded) res.end(); } catch {} };
    const doKill = () => {
      if (killed) return;
      killed = true;
      try { ff.stdout.unpipe(res); } catch {}
      killProc(ff);
      endRes();
    };
    req.on("close", doKill);
    res.on("close", doKill);
    ff.on("exit", () => { killed = true; endRes(); });
    ff.on("error", () => { killed = true; endRes(); });
  } catch (e) { res.status(500).send(e.message); }
});

// Audio file (native seek)
const audioFileJobs = new Map();   // bv -> Promise<ffmpegChild>
function biliAudioCachePath(bv) { return join(AUDIO_TMP, bv + '.mp3'); }
function getAudioJob(bv) {
  if (audioFileJobs.has(bv)) return audioFileJobs.get(bv);
  const file = biliAudioCachePath(bv);
  const part = file + '.part';
  const job = (async () => {
    try { mkdirSync(AUDIO_TMP, { recursive: true }); } catch {}
    const urls = await getStreamUrls(bv);
    if (!urls.audioUrl) throw new Error('no audio');
    const ff = spawnTracked(["-headers", "Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0", "-i", urls.audioUrl, "-ar", "44100", "-ac", "2", "-b:a", "128k", "-f", "mp3", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] }, 'bili-audio:' + bv);
    ff.stderr.on('data', () => {});
    try { unlinkSync(part); } catch {}
    const ws = createWriteStream(part);
    ff.stdout.pipe(ws);
    ff.on('error', () => {});
    ff.on('close', (code) => {
      ws.end();
      if (code === 0) { try { renameSync(part, file); } catch {} }
      else { try { unlinkSync(part); } catch {} }
    });
    return ff;
  })().catch((e) => { throw e; }).finally(() => { audioFileJobs.delete(bv); });
  audioFileJobs.set(bv, job);
  return job;
}
app.get('/api/bilibili/audio-file/:bv', async (req, res) => {
  const bv = req.params.bv;
  const file = biliAudioCachePath(bv);
  if (existsSync(file)) return res.sendFile(file, { maxAge: '30d', headers: { 'Accept-Ranges': 'bytes' } });
  let ff;
  try { ff = await getAudioJob(bv); }
  catch (e) { return res.status(500).send(e && e.message || 'audio fail'); }
  if (existsSync(file)) return res.sendFile(file, { maxAge: '30d', headers: { 'Accept-Ranges': 'bytes' } });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  if (res.flushHeaders) res.flushHeaders();
  const stop = () => { try { res.end(); } catch {} };
  const onData = (d) => { try { res.write(d); } catch {} };
  ff.stdout.on('data', onData);
  ff.stdout.on('end', stop);
  ff.on('close', stop);
  req.on('close', () => { ff.stdout.removeListener('data', onData); ff.stdout.removeListener('end', stop); });
});

// HLS stream
const streamDurationCache = new Map();
const hlsSessions = new Map();
function probeDuration(videoUrl) {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-headers", "Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoUrl], { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve(0);
      const d = parseFloat(stdout.trim());
      resolve(isFinite(d) ? d : 0);
    });
  });
}

function hlsCron() {
  const now = Date.now();
  for (const [sid, s] of hlsSessions) {
    if (now - s.lastAccess > 120000) { try { s.proc.kill('SIGKILL'); } catch {} try { rmSync(HLS_DIR + '/' + sid, { recursive: true, force: true }); } catch {} hlsSessions.delete(sid); }
  }
}
setInterval(hlsCron, 30000);

app.get('/api/bilibili/stream/:bv', async (req, res) => {
  try {
    const bv = req.params.bv, seek = parseFloat(req.query.seek || '0') || 0;
    const urls = await getStreamUrls(bv);
    if (!urls.videoUrl) return res.status(404).json({ ok: false, error: 'no stream' });
    let duration = streamDurationCache.get(bv);
    if (duration === undefined) { duration = await probeDuration(urls.videoUrl); if (duration > 0) streamDurationCache.set(bv, duration); }
    const sid = bv + '_' + Math.floor(seek * 8) + '_' + Math.random().toString(36).slice(2, 8);
    const dir = HLS_DIR + '/' + sid;
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const args = ['-headers', 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n', '-re'];
    if (seek > 0) args.push('-ss', String(seek));
    args.push('-i', urls.videoUrl);
    if (urls.audioUrl && urls.audioUrl !== urls.videoUrl) args.push('-i', urls.audioUrl);
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '10', '-hls_flags', 'independent_segments+delete_segments', '-hls_segment_filename', dir + '/seg%03d.ts', dir + '/play.m3u8');
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (d) => { try { appendFileSync(dir + '/err.log', d); } catch {} });
    hlsSessions.set(sid, { dir, proc, lastAccess: Date.now(), bv });
    let exited = false;
    proc.on('exit', () => { exited = true; const s = hlsSessions.get(sid); if (s) s.proc = null; });
    const m3u8Path = dir + '/play.m3u8';
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { if (existsSync(m3u8Path) && statSync(m3u8Path).size > 0) break; if (exited) break; await new Promise(r => setTimeout(r, 300)); }
    if (exited && !existsSync(m3u8Path)) { try { rmSync(dir, { recursive: true, force: true }); } catch {} hlsSessions.delete(sid); return res.status(502).json({ ok: false, error: 'ffmpeg exited before manifest ready' }); }
    if (!existsSync(m3u8Path)) { try { proc.kill('SIGKILL'); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} hlsSessions.delete(sid); return res.status(504).json({ ok: false, error: 'manifest not ready in time' }); }
    res.json({ ok: true, m3u8: '/api/bilibili/hls/' + sid + '/play.m3u8', sid, duration });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/bilibili/duration/:bv', async (req, res) => {
  try {
    const bv = req.params.bv;
    let duration = streamDurationCache.get(bv);
    if (duration === undefined) {
      const urls = await getStreamUrls(bv);
      if (!urls.videoUrl) return res.status(404).json({ ok: false, error: 'no stream' });
      duration = await probeDuration(urls.videoUrl);
      if ((duration <= 0) && urls.audioUrl) duration = await probeDuration(urls.audioUrl);
      if (duration > 0) streamDurationCache.set(bv, duration);
    }
    res.json({ ok: true, duration: duration || 0 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/bilibili/hls/:sid/:file', (req, res) => {
  const { sid, file } = req.params;
  if (!/^[A-Za-z0-9_.-]+$/.test(file)) return res.status(400).send('bad file');
  const s = hlsSessions.get(sid);
  if (!s || !existsSync(HLS_DIR + '/' + sid)) return res.status(404).send('no session');
  s.lastAccess = Date.now();
  try {
    const buf = readFileSync(HLS_DIR + '/' + sid + '/' + file);
    if (file.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    else if (file.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache').send(buf);
  } catch { res.status(404).send('not found'); }
});

app.get('/api/bilibili/stream/stop/:sid', (req, res) => {
  const s = hlsSessions.get(req.params.sid);
  if (s) { try { s.proc && s.proc.kill('SIGKILL'); } catch {} try { rmSync(HLS_DIR + '/' + req.params.sid, { recursive: true, force: true }); } catch {} hlsSessions.delete(req.params.sid); }
  res.json({ ok: true });
});

// ─── 电视直播 (央视+卫视多频道: 直连代理 + ffmpeg 转码 H.264) ──────────────
const LIVE_CHANNELS_FILE = join(__dirname, 'live_channels.json');
let LIVE_CHANNELS = [];
let LIVE_CH_IDX = {};
try {
  const _d = JSON.parse(readFileSync(LIVE_CHANNELS_FILE, 'utf8'));
  LIVE_CHANNELS = _d.channels || [];
  LIVE_CHANNELS.forEach((c, i) => { LIVE_CH_IDX[c.id] = i; });
  console.log('[live] channels loaded: ' + LIVE_CHANNELS.length);
} catch (e) { console.error('[live] load live_channels.json failed: ' + e.message); }
const LIVE_HEADERS = { 'Referer': 'https://tv.cctv.com/', 'User-Agent': 'Mozilla/5.0' };
// ffmpeg 的 -headers 用 CRLF 分隔, 并以 CRLF 结尾(不结尾 ffmpeg 会警告并自行补,
// 但实测部分源会因此返回 400)。全站统一用这一份, 避免探测端与消费端不一致。
const LIVE_FFMPEG_HEADERS = 'Referer: https://tv.cctv.com/\r\nUser-Agent: Mozilla/5.0\r\n';
const LIVE_HLS_ROOT = '/tmp/live_hls';
const LIVE_IDLE_MS = 30000;
const LIVE_MAX_RUN = 3;
const liveSessions = new Map();

function liveBase(url) { return url.replace(/[?#].*$/, '').replace(/[^/]*$/, ''); }
function liveSegUrl(source, seg) { return (/^https?:\/\//i.test(seg)) ? seg : (liveBase(source) + seg); }
function liveSafeId(ch) { return Buffer.from(ch).toString('base64url').slice(0, 16); }
function liveDir(ch) { return LIVE_HLS_ROOT + '/' + liveSafeId(ch); }
function liveChan(ch) { return LIVE_CHANNELS[LIVE_CH_IDX[ch]] || null; }

async function liveFetchFailover(srcs, startIdx) {
  let lastErr;
  for (let i = 0; i < srcs.length; i++) {
    const idx = (startIdx + i) % srcs.length;
    const src = srcs[idx];
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 12000);
      const r = await fetch(src, { headers: LIVE_HEADERS, signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) { lastErr = new Error('http ' + r.status); continue; }
      return { r, src, idx };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all sources failed');
}

// ─── 直播源仲裁(全频道唯一决策) ────────────────────────────────────────
// 修复「声音是广告、画面是正常频道」——两个独立成因, 缺一不可:
//   (1) 无共享状态: 视频(/ws/frames?live=)与音频(/api/live/:ch/audio)原先各自
//       独立调用 liveFetchFailover(srcs, 0)。探测时刻稍有差异(超时/ffmpeg 起播
//       即退/WS 断线重连后重探)就会各落一个源, 且永远不会自行收敛。
//   (2) 跳转分发器: 部分源是 302 分发器, 同一 URL 每次请求跳到不同的真实流
//       (实测 cctv1 的源 #1 分别跳到 applive/yss.m3u8 和 applive/102.m3u8)。
//       所以「同一个源 URL」并不等于「同一条流」——必须把跳转跟到底, 缓存最终 URL。
// 另外: 探测必须由 ffprobe 完成。Node fetch 只看 HTTP 200, 而真正消费源的是 ffmpeg,
// 两者请求头/协议行为不同, 会出现「探测 200 但 ffmpeg 打不开」的假健康源。
const LIVE_SRC_TTL_MS = 6 * 3600 * 1000;       // 普通源: 整段行程保持同一决策
const LIVE_SRC_TTL_REDIR_MS = 20 * 60 * 1000;  // 跳转源: 最终 URL 带 token, 需重探
const liveSrcState = new Map();                // ch -> { idx, src, origin, ts, fails }
const liveSrcPending = new Map();              // ch -> Promise, 并发调用共享同一次探测
const liveHealth = new Map();                  // url -> { ok, ts, info }
const LIVE_HEALTH_TTL_MS = 5 * 60 * 1000;
const LIVE_PROBE_TIMEOUT_MS = 8000;
const LIVE_MOTION_TIMEOUT_MS = 12000;
const LIVE_PROBE_MAX_PAR = 6;                  // 全局 ffprobe 并发上限
let liveProbeRunning = 0;
const liveProbeQueue = [];
// 「连得上但迟迟不出画面」也是一种坏源。ffprobe/动态性体检只能证明「能解出视频流」,
// 证明不了「多久出第一帧」—— 实测有源首帧要 19~46s。这类源在直播里等于不可用:
// 客户端会一直卡在遮罩上, 而旧代码没有任何东西会因此作废它, 于是永久缓存坏源。
const LIVE_FIRST_FRAME_TIMEOUT_MS = 25000;
const liveTimeoutStreak = new Map();           // ch -> 连续首帧超时次数

function liveProbeSlot() {
  if (liveProbeRunning < LIVE_PROBE_MAX_PAR) { liveProbeRunning++; return Promise.resolve(); }
  return new Promise((r) => liveProbeQueue.push(r));
}
function liveProbeRelease() {
  const next = liveProbeQueue.shift();
  if (next) next(); else liveProbeRunning--;
}

// 广告网特征: 这套海外"免费 IPTV"网把频道映射到 /applive/<mkt|yss|byt|102|107>.m3u8
// 等广告/养生垫片流上(实测 CCTV-1 被喂成「麦可通」保健品广告)。
// 这类源 ffprobe 是"健康"的 —— 它确实是合法视频, 只是内容不是该频道, 所以必须按
// 跳转目标单独拒收。注意判别依据是"跳转目标", 不是主机: 同一主机既可能跳到
// /applive/(广告)也可能跳到 /live/*md.m3u8(正常镜像)。
const LIVE_AD_URL_RE = /\/applive\/|\/(mkt|yss|byt)\.m3u8|kwimgs\.com|kuaishou/i;

// 用 ffprobe 体检单个源: 只有"真的能解出 video 流"才算健康
function liveProbeSource(url) {
  const hit = liveHealth.get(url);
  if (hit && Date.now() - hit.ts < LIVE_HEALTH_TTL_MS) return Promise.resolve(hit);
  return liveProbeSlot().then(() => new Promise((resolve) => {
    const args = [
      '-hide_banner', '-v', 'error',
      '-headers', LIVE_FFMPEG_HEADERS,
      '-analyzeduration', '3000000', '-probesize', '2000000',
      '-show_entries', 'stream=codec_name,codec_type,width,height',
      '-of', 'csv=p=0', url
    ];
    let out = '', settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const rec = { ok, ts: Date.now(), info: out.trim().split('\n').slice(0, 3).join(' | ') };
      liveHealth.set(url, rec);
      liveProbeRelease();
      resolve(rec);
    };
    let proc;
    const timer = setTimeout(() => { try { proc && proc.kill('SIGKILL'); } catch {} }, LIVE_PROBE_TIMEOUT_MS);
    try { proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { done(false); return; }
    proc.stdout.on('data', (d) => { out += d.toString(); if (out.length > 3000) out = out.slice(0, 3000); });
    proc.on('error', () => done(false));
    proc.on('close', () => done(/(^|\n)[^\n]*,video,/.test(out)));
  }));
}

// 画面动态性探测: ffmpeg 解 4 秒 @2fps, 缩到 64x36 灰度 rawvideo, 比较相邻帧平均绝对差。
// 真频道画面持续变化; 彩条测试卡/垫片流是静止的 -> 帧差接近 0(实测 0.15 vs 真频道 13.9+)。
function liveProbeMotion(url) {
  return liveProbeSlot().then(() => new Promise((resolve) => {
    const W = 64, H = 36;
    const args = [
      '-hide_banner', '-v', 'error', '-headers', LIVE_FFMPEG_HEADERS,
      '-i', url, '-an', '-t', '4',
      '-vf', `fps=2,scale=${W}:${H},format=gray`,
      '-f', 'rawvideo', 'pipe:1'
    ];
    const bufs = [];
    let len = 0, settled = false, proc;
    const done = (rec) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveProbeRelease();
      resolve(rec);
    };
    const timer = setTimeout(() => { try { proc && proc.kill('SIGKILL'); } catch {} }, LIVE_MOTION_TIMEOUT_MS);
    try { proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { done({ ok: false }); return; }
    proc.stdout.on('data', (d) => { bufs.push(d); len += d.length; });
    proc.on('error', () => done({ ok: false }));
    proc.on('close', () => {
      const all = Buffer.concat(bufs, len);
      const n = Math.floor(all.length / (W * H));
      if (n < 3) return done({ ok: false, frames: n });
      const diffs = [];
      for (let i = 1; i < n; i++) {
        let s = 0;
        const a = (i - 1) * W * H, b = i * W * H;
        for (let k = 0; k < W * H; k++) s += Math.abs(all[a + k] - all[b + k]);
        diffs.push(s / (W * H));
      }
      const mean = diffs.reduce((x, y) => x + y, 0) / diffs.length;
      done({ ok: true, frames: n, meanDiff: +mean.toFixed(2), maxDiff: +Math.max(...diffs).toFixed(2) });
    });
  }));
}

// 综合判定一个源: 跳转目标 + ffprobe 体检 + 画面动态性。结果按原 URL 缓存。
// 动态性用来识别"测试卡/垫片流": 彩条测试卡是静止画面(实测相邻帧差 0.15),
// 而真频道持续变化(13.9+), 阈值取得很保守 —— 只有"又静又无起伏"才判为垫片。
const LIVE_MIN_MOTION = 1.0;      // 相邻帧平均绝对差下限
const LIVE_MIN_MOTION_MAX = 3.0;  // 同时要求最大帧差也低, 避免误杀静止镜头
const liveSrcCheck = new Map();   // url -> { ok, ad, static, finalUrl, info, ts }
async function liveClassifySource(url) {
  const hit = liveSrcCheck.get(url);
  if (hit && Date.now() - hit.ts < LIVE_HEALTH_TTL_MS) return hit;
  const [finalUrl, health, motion] = await Promise.all([
    liveFollowRedirect(url),
    liveProbeSource(url).catch(() => ({ ok: false, info: '' })),
    liveProbeMotion(url).catch(() => ({ ok: false }))
  ]);
  const ad = LIVE_AD_URL_RE.test(finalUrl);
  const isStatic = !!motion.ok && motion.meanDiff < LIVE_MIN_MOTION && motion.maxDiff < LIVE_MIN_MOTION_MAX;
  const ok = !!health.ok && !ad && !isStatic;
  const rec = {
    ok, ad, static: isStatic, finalUrl, ts: Date.now(),
    info: (health.info || '') + (motion.ok ? ` | motion ${motion.meanDiff}/${motion.maxDiff}` : '')
  };
  liveSrcCheck.set(url, rec);
  if (ad) console.warn(`[live-src] 拒收广告源 ${url}  =>  ${finalUrl}`);
  else if (isStatic) console.warn(`[live-src] 拒收静止垫片源 ${url}  (帧差 ${motion.meanDiff})`);
  return rec;
}

function liveSrcGet(ch) {
  const st = liveSrcState.get(ch);
  if (!st) return null;
  // 人工切源不受跳转 token 的短有效期限制: 用户的选择优先, 坏了再走失败惩罚
  if (st.manual) return st;
  const ttl = (st.origin && st.origin !== st.src) ? LIVE_SRC_TTL_REDIR_MS : LIVE_SRC_TTL_MS;
  if (Date.now() - st.ts > ttl) { liveSrcState.delete(ch); return null; }
  return st;
}
function liveSrcSet(ch, idx, src, origin) {
  const st = { idx, src, origin: origin || src, ts: Date.now(), fails: 0, manual: false };
  liveSrcState.set(ch, st);
  console.log(`[live-src] ${ch} 选用源 #${idx} ${src}${origin && origin !== src ? '  <= ' + origin : ''}`);
  return st;
}
// 手动切源: 从 startIdx 起顺时针找一个可用的源。
// 第一轮只用**已有**体检结论跳过"已知不合格"的源(广告 / 静止垫片 / 解不出视频流)。
// 关键是"只用已有的": 现场跑一遍 ffprobe+动态性要十几秒, 按一次换源等那么久不可接受;
// 而这些结论在自动选源时已经算过并缓存了, 直接拿来用是免费的。
// 第二轮(第一轮全被跳过时)退回"只要能连上就用" —— 自动判定可能误杀也可能漏判,
// 判断权最终还是要交回用户: 他再按一次换源就能继续往前走。
async function liveResolveSrcFrom(ch, startIdx) {
  const chan = liveChan(ch);
  if (!chan || !chan.srcs || !chan.srcs.length) throw new Error('no channel ' + ch);
  const n = chan.srcs.length;
  let lastErr;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const idx = (((startIdx + i) % n) + n) % n;
      const raw = chan.srcs[idx];
      if (pass === 0) {
        const c = liveSrcCheck.get(raw);
        if (c && Date.now() - c.ts < LIVE_HEALTH_TTL_MS && !c.ok) {
          console.log(`[live-src] ${ch} 换源跳过已知不合格源 #${idx}/${n}`
            + (c.ad ? '(广告)' : c.static ? '(静止垫片)' : '(无视频流)') + ' ' + raw);
          continue;
        }
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      try {
        const r = await fetch(raw, { headers: LIVE_HEADERS, signal: ac.signal });
        const finalUrl = r.url || raw;
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch {}
        if (!r.ok) { lastErr = new Error('http ' + r.status); continue; }
        const st = liveSrcSet(ch, idx, finalUrl, raw);
        st.manual = true;                    // 人工选择: 不被自动体检覆盖
        console.log(`[live-src] ${ch} 手动切到源 #${idx}/${n} ${finalUrl}`
          + (pass ? '  (已无合格源, 退回可达性)' : ''));
        return st;
      } catch (e) { lastErr = e; } finally { clearTimeout(t); }
    }
  }
  throw lastErr || new Error('all sources failed');
}
// 源被判失败(ffmpeg 起播即退/HTTP 错): 连续 2 次就作废决策, 下次重新探测
function liveSrcPenalize(ch, idx) {
  const st = liveSrcState.get(ch);
  if (!st || st.idx !== idx) return;
  st.fails = (st.fails || 0) + 1;
  if (st.fails >= 2) {
    liveSrcState.delete(ch);
    console.log(`[live-src] ${ch} 源 #${idx} 连续失败 ${st.fails} 次, 作废决策`);
  }
}
// 把一个源 URL 的跳转跟到底, 返回最终 URL(失败则原样返回)
async function liveFollowRedirect(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, { headers: LIVE_HEADERS, signal: ac.signal });
    const finalUrl = r.url || url;
    // 只解析跳转, 不消费直播流
    try { if (r.body && r.body.cancel) await r.body.cancel(); } catch {}
    return finalUrl;
  } catch { return url; } finally { clearTimeout(t); }
}

// 全站唯一入口: 返回该频道当前应使用的源(缓存 + 并发去重 + 体检 + 跳转解析)
async function liveResolveSrc(ch, force) {
  const chan = liveChan(ch);
  if (!chan || !chan.srcs || !chan.srcs.length) throw new Error('no channel ' + ch);
  if (!force) { const st = liveSrcGet(ch); if (st) return st; }
  if (liveSrcPending.has(ch)) return liveSrcPending.get(ch);
  const p = (async () => {
    // 1) 并行判定所有源(带缓存): 跳转目标 + ffprobe 体检, 取下标最小的合格源
    const checks = await Promise.all(chan.srcs.map((u) => liveClassifySource(u).catch(() => ({ ok: false }))));
    const idx = checks.findIndex((c) => c && c.ok);
    if (idx >= 0) return liveSrcSet(ch, idx, checks[idx].finalUrl, chan.srcs[idx]);
    // 2) 全部不合格 -> 退回"只看可达性"的老策略, 至少不至于完全没画面
    const adN = checks.filter((c) => c && c.ad).length;
    console.warn(`[live-src] ${ch} 无合格源(${chan.srcs.length} 个中 ${adN} 个为广告源), 退回可达性探测`);
    const { src, idx: i } = await liveFetchFailover(chan.srcs, 0);
    return liveSrcSet(ch, i, await liveFollowRedirect(src), src);
  })();
  liveSrcPending.set(ch, p);
  try { return await p; } finally { liveSrcPending.delete(ch); }
}

// 转码会话管理: 每频道独立 ffmpeg, 自动在源间 failover
function liveEvictIfFull() {
  if (liveSessions.size >= LIVE_MAX_RUN) {
    let oldest = null, ok = false;
    for (const s of liveSessions.values()) { if (s.proc && (!oldest || s.lastAccess < oldest.lastAccess)) oldest = s; }
    if (oldest) { try { oldest.proc.kill('SIGKILL'); } catch {} oldest.proc = null; }
  }
}

function liveSpawn(ch, src, activeSrc) {
  const dir = liveDir(ch);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const enc = encodeURIComponent(ch);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-headers', LIVE_FFMPEG_HEADERS,
    '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '26', '-g', '48',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_base_url', '/api/live/' + enc + '/transcode/',
    '-hls_segment_filename', dir + '/seg%03d.ts',
    dir + '/play.m3u8'
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => { try { appendFileSync(dir + '/err.log', d); } catch {} });
  let s = liveSessions.get(ch);
  if (!s) { s = { proc: null, lastAccess: Date.now(), startedAt: Date.now(), activeSrc: 0 }; liveSessions.set(ch, s); }
  s.proc = proc; s.activeSrc = activeSrc; s.lastAccess = Date.now();
  proc.on('exit', () => { if (liveSessions.get(ch) && liveSessions.get(ch).proc === proc) liveSessions.get(ch).proc = null; });
  proc.on('error', () => { if (liveSessions.get(ch) && liveSessions.get(ch).proc === proc) liveSessions.get(ch).proc = null; });
  return proc;
}

// 确保有可用转码: 返回 play.m3u8 是否就绪(同步路径)
function liveEnsure(ch) {
  const chan = liveChan(ch);
  if (!chan) return false;
  let s = liveSessions.get(ch);
  if (s && s.proc) { s.lastAccess = Date.now(); return existsSync(liveDir(ch) + '/play.m3u8'); }
  // 启动(若已满则驱逐最久未用的)
  liveEvictIfFull();
  // 源优先级: 全局仲裁决策 > 本会话上次用的源 > 0
  // 仲裁有最终 URL(跳转已跟到底)就用它, 与音/帧流同一条流
  const ast = liveSrcGet(ch);
  const activeSrc = (ast ? ast.idx : ((s && s.activeSrc) || 0)) % chan.srcs.length;
  const src = (ast && ast.idx === activeSrc) ? ast.src : chan.srcs[activeSrc];
  liveSpawn(ch, src, activeSrc);
  return existsSync(liveDir(ch) + '/play.m3u8');
}

app.get('/api/live/channels', (req, res) => {
  res.json({ ok: true, list: LIVE_CHANNELS.map(c => ({ id: c.id, title: c.title, group: c.group })) });
});

// 诊断: 当前各频道的源决策 —— 音画是否同源, 一眼可见
app.get('/api/live/status', (req, res) => {
  const list = [];
  for (const [ch, st] of liveSrcState) {
    const chan = liveChan(ch);
    list.push({
      ch, idx: st.idx, src: st.src, total: chan ? chan.srcs.length : 0,
      redirect: st.origin && st.origin !== st.src ? st.origin : null,
      manual: !!st.manual,
      ageMs: Date.now() - st.ts, fails: st.fails || 0
    });
  }
  list.sort((a, b) => a.ch.localeCompare(b.ch));
  res.json({ ok: true, count: list.length, list });
});
// 源体检报告: 哪些源能真的解出视频流(排查「源里有广告频道 / 假健康源」)
app.get('/api/live/health', (req, res) => {
  const list = [];
  for (const [url, c] of liveSrcCheck) {
    list.push({ url, ok: c.ok, ad: !!c.ad, static: !!c.static, finalUrl: c.finalUrl, ageMs: Date.now() - c.ts, info: c.info });
  }
  for (const [url, h] of liveHealth) {
    if (liveSrcCheck.has(url)) continue;
    list.push({ url, ok: h.ok, ad: false, static: false, finalUrl: null, ageMs: Date.now() - h.ts, info: h.info });
  }
  list.sort((a, b) => (a.ok === b.ok ? (b.ad ? 1 : 0) - (a.ad ? 1 : 0) : (a.ok ? -1 : 1)));
  res.json({
    ok: true, count: list.length,
    adCount: list.filter((x) => x.ad).length,
    staticCount: list.filter((x) => x.static).length,
    list
  });
});
app.get('/api/live/:ch/status', (req, res) => {
  const ch = req.params.ch;
  const chan = liveChan(ch);
  if (!chan) return res.status(404).json({ ok: false, error: 'no channel' });
  const st = liveSrcGet(ch);
  const s = liveSessions.get(ch);
  res.json({
    ok: true, ch, total: chan.srcs.length,
    resolved: st ? { idx: st.idx, src: st.src, origin: st.origin, manual: !!st.manual, ageMs: Date.now() - st.ts, fails: st.fails || 0 } : null,
    srcs: chan.srcs,
    health: chan.srcs.map((u) => {
      const c = liveSrcCheck.get(u);
      if (c) return { ok: c.ok, ad: !!c.ad, static: !!c.static, finalUrl: c.finalUrl, info: c.info, ageMs: Date.now() - c.ts };
      const h = liveHealth.get(u);
      return h ? { ok: h.ok, ad: false, static: false, ageMs: Date.now() - h.ts } : null;
    }),
    session: s ? { activeSrc: s.activeSrc, hasProc: !!s.proc, lastAccess: s.lastAccess } : null
  });
});
// 手动切换源: 换到该频道的下一个源。不做健康/广告过滤(用户兜底开关)。
app.get('/api/live/:ch/nextsrc', async (req, res) => {
  const ch = req.params.ch;
  const chan = liveChan(ch);
  if (!chan) return res.status(404).json({ ok: false, error: 'no channel' });
  try {
    const cur = liveSrcState.get(ch);
    const startIdx = cur ? cur.idx + 1 : 0;
    const st = await liveResolveSrcFrom(ch, startIdx);
    // 让转码会话也切到新源, 否则 HLS 通道还挂在旧源上
    const s = liveSessions.get(ch);
    if (s && s.proc) { try { s.proc.kill('SIGKILL'); } catch {} s.proc = null; }
    res.json({ ok: true, ch, idx: st.idx, src: st.src, total: chan.srcs.length, manual: true });
  } catch (e) {
    res.json({ ok: false, ch, error: e.message });
  }
});
// 主动解析(运维/批量体检用): 强制重新判定该频道的源并返回结论
app.get('/api/live/:ch/probe', async (req, res) => {
  const ch = req.params.ch;
  const chan = liveChan(ch);
  if (!chan) return res.status(404).json({ ok: false, error: 'no channel' });
  const t0 = Date.now();
  try {
    const st = await liveResolveSrc(ch, true);
    const checks = chan.srcs.map((u) => {
      const c = liveSrcCheck.get(u);
      return { url: u, ok: c ? c.ok : null, ad: c ? !!c.ad : null, static: c ? !!c.static : null, finalUrl: c ? c.finalUrl : null };
    });
    res.json({ ok: true, ch, idx: st.idx, src: st.src, origin: st.origin, total: chan.srcs.length, ms: Date.now() - t0, checks });
  } catch (e) {
    res.json({ ok: false, ch, error: e.message, ms: Date.now() - t0 });
  }
});

// 直连代理(备用): 重写分片为 /api/live/:ch/seg
app.get('/api/live/:ch/index.m3u8', async (req, res) => {
  const chan = liveChan(req.params.ch);
  if (!chan) return res.status(404).send('no channel');
  try {
    // 与音/视频同一份源决策(此前各自 liveFetchFailover(srcs,0), 会分叉)
    const st = await liveResolveSrc(req.params.ch);
    const src = st.src;
    const r = await fetch(src, { headers: LIVE_HEADERS });
    if (!r.ok) { liveSrcPenalize(req.params.ch, st.idx); throw new Error('http ' + r.status); }
    const text = await r.text();
    const enc = encodeURIComponent(req.params.ch);
    const out = text.split(/\r?\n/).map((ln) => {
      const t = ln.trim();
      if (!t || t.startsWith('#') || /^https?:\/\//i.test(t) || t.endsWith('.m3u8')) return ln;
      return '/api/live/' + enc + '/seg?u=' + encodeURIComponent(liveSegUrl(src, t));
    }).join('\n');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(out);
  } catch (e) { res.status(502).send('live proxy error: ' + e.message); }
});

app.get('/api/live/:ch/seg', async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).send('no u');
    // 加固 v2 (S8): 原实现会服务端拉取**任意**用户给定 URL 并原样返回 —— 开放
    // 代理 / SSRF（可探内网、可当跳板）。该端点目前没有任何前端在用（直播走
    // /ws/frames 与 /transcode.m3u8），因此限制为"该频道已解析出的源同主机"。
    if (!liveSegUrlAllowed(req.params.ch, u)) return res.status(403).send('forbidden');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(u, { headers: LIVE_HEADERS, signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return res.status(r.status).send('seg fetch failed');
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).send('seg proxy error: ' + e.message); }
});

// 转码 HLS (默认播放通道, 车机可硬解 H.264)
app.get('/api/live/:ch/transcode.m3u8', (req, res) => {
  if (!liveChan(req.params.ch)) return res.status(404).send('no channel');
  let ready = liveEnsure(req.params.ch);
  const dir = liveDir(req.params.ch);
  const p = dir + '/play.m3u8';
  const deadline = Date.now() + 20000;
  // 加固 v2 (S13): 原循环不随客户端断开取消，且末尾的 readFileSync(p) 在 try
  // 之外 —— 文件恰好消失时会在定时器回调里抛异常，导致整个进程退出。
  // 现在：客户端断开即停止轮询，且所有读取都在 try 内。
  let segClosed = false;
  req.on('close', () => { segClosed = true; });
  (function wait() {
    if (segClosed) return;
    try { const buf = readFileSync(p); if (buf.length > 0) { ready = true; } } catch {}
    if (ready) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      try { return res.send(readFileSync(p)); }
      catch { return res.status(504).send('live manifest vanished'); }
    }
    // 进程已退出且无产出 -> 切下一源重试
    const s = liveSessions.get(req.params.ch);
    const chan = liveChan(req.params.ch);
    if (s && !s.proc && chan) {
      liveEvictIfFull();
      const next = (s.activeSrc + 1) % chan.srcs.length;
      liveSpawn(req.params.ch, chan.srcs[next], next);
      // 作废仲裁: 音频/帧流下次解析会重新体检并重新跟跳转, 与转码取到同一条流。
      // (直接塞 chan.srcs[next] 会把已跟到底的最终 URL 覆盖成原始跳转 URL)
      liveSrcState.delete(req.params.ch);
    }
    if (Date.now() > deadline) return res.status(504).send('live transcode not ready');
    setTimeout(wait, 500);
  })();
});

app.get('/api/live/:ch/transcode/:file', (req, res) => {
  const f = req.params.file;
  if (!/^[A-Za-z0-9_.-]+$/.test(f)) return res.status(400).send('bad file');
  const s = liveSessions.get(req.params.ch);
  if (s) s.lastAccess = Date.now();
  const path = liveDir(req.params.ch) + '/' + f;
  if (!existsSync(path)) return res.status(404).send('no file');
  if (f.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(readFileSync(path));
});

// 清理解析(转码失败会话) + 空闲回收
app.get('/api/live/:ch/stop', (req, res) => {
  const s = liveSessions.get(req.params.ch);
  if (s && s.proc) { try { s.proc.kill('SIGKILL'); } catch {} s.proc = null; }
  res.json({ ok: true });
});

// 直播 D档 音频: ffmpeg 从直播源抽取音频 -> WAV 流式给 <audio> (实时, 无 seek)
app.get('/api/live/:ch/audio', async (req, res) => {
  try {
    const ch = req.params.ch;
    const chan = liveChan(ch);
    if (!chan) return res.status(404).send('no channel');
    // 与 /ws/frames?live= 共用同一份源决策 —— 这是「声音是广告、画面是正常频道」的根治点
    const st = await liveResolveSrc(ch);
    const aSrc = st.src;
    console.log(`[live-audio] ${ch} src#${st.idx}=${aSrc}`);
    const a = ['-headers', LIVE_FFMPEG_HEADERS, '-fflags', 'nobuffer+discardcorrupt', '-flags', 'low_delay'];
    a.push('-i', aSrc, '-vn', '-ar', '44100', '-ac', '2', '-f', 'wav', 'pipe:1');
    // 同 /api/bilibili/audio/:bv：裸 spawn 不进注册表，断流后进程残留、/api/cleanup 也扫不到。
    // 直播是无限流，4h 超时仅作兜底（正常应由客户端断开触发清理）。
    const audioT0 = Date.now();
    const ff = spawnTracked(a, { timeout: 4 * 3600 * 1000 }, 'live-audio:' + ch);
    res.setHeader('Content-Type', 'audio/wav').setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    let audioBytes = 0;
    ff.stdout.on('data', (d) => { audioBytes += d.length; });
    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {});
    let killed = false;
    const endRes = () => { try { if (!res.writableEnded) res.end(); } catch {} };
    const doKill = () => {
      if (killed) return;
      killed = true;
      try { ff.stdout.unpipe(res); } catch {}
      killProc(ff);
      endRes();
    };
    req.on('close', doKill);
    res.on('close', doKill);
    ff.on('exit', (code, signal) => {
      killed = true; endRes();
      // 音频源失败也要记账: 否则坏源只被视频路径惩罚, 音频会一直挂在坏源上
      if (signal === 'SIGKILL') return;
      const alive = Date.now() - audioT0;
      if (audioBytes < 8192 || alive < 8000) {
        console.warn(`[live-audio] ${ch} 源#${st.idx} 失败 bytes=${audioBytes} alive=${alive}ms code=${code}`);
        liveSrcPenalize(ch, st.idx);
      }
    });
    ff.on('error', () => { killed = true; endRes(); });
  } catch (e) { res.status(500).send(e.message); }
});

setInterval(() => {
  const now = Date.now();
  for (const [ch, s] of liveSessions) {
    if (!s.proc) { liveSessions.delete(ch); continue; }
    if (now - s.lastAccess > LIVE_IDLE_MS) { try { s.proc.kill('SIGKILL'); } catch {} s.proc = null; liveSessions.delete(ch); console.log('[live] idle stop: ' + ch); }
  }
}, 15000);

// ─── Init & Start ─────────────────────────────────────────────────────
async function init() {
  for (const d of [VIDEOS_DIR, SUBTITLES_DIR, CACHE_DIR, SEGS_DIR, LYRICS_DIR, MUSIC_DIR, MIC_LOG_DIR, THUMB_DIR])
    await mkdir(d, { recursive: true });
  console.log(`Videos: ${VIDEOS_DIR}`);
  console.log(`Segments: ${SEGS_DIR} (LRU cap ${SEGS_MAX_BYTES / 1024 / 1024 / 1024}GB)`);
}

init().then(() => {
  server.listen(PORT, () => console.log(`Tesla Video Player running on http://0.0.0.0:${PORT}`));
  try {
    const sslOpts = { key: readFileSync(join(__dirname, 'ssl.key')), cert: readFileSync(join(__dirname, 'ssl.crt')) };
    const httpsServer = createHttpsServer(sslOpts, app);
    httpsServer.listen(HTTPS_PORT, () => console.log(`HTTPS on port ${HTTPS_PORT}`));
    httpsServer.on("upgrade", (req, socket, head) => {
      let url;
      try { url = new URL(req.url, "http://x"); } catch { socket.destroy(); return; }
      if (url.pathname === "/ws/frames") wss.handleUpgrade(req, socket, head, (ws) => handleFrames(ws, url));
      else if (url.pathname === "/ws/mpeg1") wss.handleUpgrade(req, socket, head, (ws) => handleMpeg1(ws, url));
      else { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); }
    });
  } catch (e) { console.warn('HTTPS setup failed:', e.message); }
});

// Cleanup on exit
process.on('SIGTERM', () => { console.log('[shutdown] cleaning up ffmpeg...'); cleanupAllFfmpeg(); process.exit(0); });
process.on('SIGINT', () => { console.log('[shutdown] cleaning up ffmpeg...'); cleanupAllFfmpeg(); process.exit(0); });
