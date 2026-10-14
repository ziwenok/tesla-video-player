import { execFile, spawn } from 'child_process';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import crypto from 'crypto';

const VIDEOS_DIR = join(process.cwd(), 'videos');
const TEMP_DIR = join(VIDEOS_DIR, '.bilibili');
const COOKIE_FILE = join(TEMP_DIR, '.bili-cookies.json');

const downloads = new Map();
let dlId = 0;
let biliCookies = null;

function ensureDirs() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function loadCookies() {
  try {
    if (existsSync(COOKIE_FILE)) {
      biliCookies = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
    }
  } catch (e) { biliCookies = null; }
}

function saveCookies(cookies) {
  ensureDirs();
  writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  biliCookies = cookies;
}

function getCookieString() {
  if (!biliCookies) return '';
  return Object.entries(biliCookies).map(([k, v]) => k + '=' + v).join('; ');
}

function biliFetch(url, opts = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (Chrome/120.0.0.0) Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    ...opts.headers,
  };
  const cookie = getCookieString();
  if (cookie) headers['Cookie'] = cookie;
  return fetch(url, { ...opts, headers });
}

// ===== Search =====
// 2026-10-04: 旧路径 x/web-interface/search/type 已被 B站风控 ——
// 返回 HTTP 412 + 一张 HTML 错误页，服务端 res.json() 直接抛
// "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"，前端只能显示「搜索失败」。
// 改用 wbi 路径 x/web-interface/wbi/search/type，并做 wbi 签名 + 带 buvid3 cookie。
// 注意：搜索结果不属于任何上级列表，bili.html 的「喜人 / 脱口秀」主题也走这个接口，
// 所以这一处坏掉会同时影响搜索框和两个主题入口。
let _buvidCache = null;
async function getBuvidCached() {
  if (_buvidCache) return _buvidCache;
  _buvidCache = await getBuvid();
  return _buvidCache;
}

// 搜索结果的 title 带 <em class="keyword"> 高亮标签，且可能含 &amp; 之类实体。
// &amp; 必须最后替换，否则 &amp;lt; 会被还原成 <。
function unescapeHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export async function searchBili(keyword, page = 1) {
  const params = { search_type: 'video', keyword, page, wts: 0 };
  let url;
  try {
    const { imgKey, subKey } = await getWbiKeys();
    url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?' + encWbi(params, imgKey, subKey);
  } catch (e) {
    // 取不到 wbi key 也别直接躺平：wbi 路径不签名通常也能返回
    url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword='
        + encodeURIComponent(keyword) + '&page=' + page;
  }
  const buvid = await getBuvidCached();
  let cookie = buvid ? 'buvid3=' + buvid + ';' : '';
  if (biliCookies) cookie = getCookieString() + (buvid ? '; buvid3=' + buvid : '');
  const res = await biliFetch(url, cookie ? { headers: { Cookie: cookie } } : {});
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('B站返回非 JSON（HTTP ' + res.status + '，多半是风控拦截）'); }
  if (data.code !== 0) throw new Error(data.message || 'search failed');
  const results = (data.data?.result || []).map(v => ({
    bvid: v.bvid,
    title: unescapeHtml(v.title || ''),
    author: v.author || '',
    duration: v.duration || '',
    play: v.play || 0,
    pic: v.pic || '',
    description: unescapeHtml(v.description || '').slice(0, 100),
  }));
  return { results, total: data.data?.numResults || 0, page };
}

// ===== Popular =====
export async function getPopular(page = 1) {
  const url = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=' + page;
  const res = await biliFetch(url);
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'popular failed');
  const list = (data.data?.list || []).map(v => ({
    bvid: v.bvid,
    title: v.title,
    author: v.owner?.name || '',
    duration: v.duration || 0,
    play: v.stat?.view || 0,
    pic: v.pic || '',
  }));
  return { list, page };
}

// ===== QR Login =====
export async function generateQR() {
  const res = await biliFetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'QR generate failed');
  return { qrcode_key: data.data.qrcode_key, qr_url: data.data.url };
}

/* ── 二维码缓存 ────────────────────────────────────────────────────────────
   必须缓存！否则 /qr/meta 与 /qr/image 各自生成一个二维码：
   用户扫的是 image 那张，前端却用 meta 返回的 key 轮询 —— 永远轮询不到，
   表现为"扫码没反应"。

   B站二维码约 180 秒过期，这里缓存 100 秒留足余量；
   过期后自动重新生成。前端可用 ?refresh=1 强制刷新。 */
const QR_TTL_MS = 100 * 1000;
let qrCache = { at: 0, qr: null };
let qrPending = null;      // 并发去重：同时来多个请求只生成一次

export async function getQRCode({ force = false } = {}) {
  const now = Date.now();
  if (!force && qrCache.qr && now - qrCache.at < QR_TTL_MS) return qrCache.qr;

  // 并发去重：避免同一时刻多个请求各生成一个（又会不一致）
  if (qrPending) return qrPending;

  qrPending = (async () => {
    try {
      const qr = await generateQR();
      qrCache = { at: Date.now(), qr };
      return qr;
    } finally {
      qrPending = null;
    }
  })();
  return qrPending;
}

/** 登录成功后清掉缓存的二维码（下次登录会重新生成）。 */
export function clearQRCode() {
  qrCache = { at: 0, qr: null };
}

export async function pollQR(qrcode_key) {
  const url = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + qrcode_key;
  const res = await biliFetch(url);
  const data = await res.json();
  if (data.code !== 0) return { status: 'error', message: data.message };

  const status = data.data.code; // 86038=expired, 86090=scanned, 86091=confirmed, 0=success
  if (status === 0) {
    // Extract cookies from Set-Cookie headers
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookies = {};
    for (const sc of setCookies) {
      const m = sc.match(/^([^=]+)=([^;]*)/);
      if (m) cookies[m[1]] = m[2];
    }
    if (Object.keys(cookies).length > 0) {
      saveCookies(cookies);
    }
    return { status: 'success', cookies: Object.keys(cookies) };
  }
  if (status === 86038) return { status: 'expired' };
  if (status === 86090) return { status: 'scanned' };
  if (status === 86091) return { status: 'confirmed' };
  return { status: 'waiting' };
}

export function isLoggedIn() {
  return !!biliCookies && !!biliCookies.SESSDATA;
}

export function logout() {
  biliCookies = null;
  try { if (existsSync(COOKIE_FILE)) writeFileSync(COOKIE_FILE, '{}'); } catch (e) {}
}

// ===== Video info =====
export function parseBiliUrl(input) {
  input = input.trim();
  let bv = null;
  const patterns = [
    /bilibili\.com\/video\/(BV[A-Za-z0-9]+)/,
    /b23\.tv\/(BV[A-Za-z0-9]+)/,
    /^(BV[A-Za-z0-9]+)$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) { bv = m[1]; break; }
  }
  if (!bv) return null;
  return { bv, url: 'https://www.bilibili.com/video/' + bv };
}

export function getBiliInfo(bv) {
  return new Promise((resolve, reject) => {
    const url = 'https://www.bilibili.com/video/' + bv;
    execFile('yt-dlp', ['--dump-json', '--no-playlist', url], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const info = JSON.parse(stdout);
        resolve({
          bv: info.id,
          title: info.title,
          duration: Math.round(info.duration || 0),
          thumbnail: info.thumbnail || '',
          uploader: info.uploader || info.channel || '',
          viewCount: info.view_count || 0,
        });
      } catch (e) { reject(e); }
    });
  });
}

// ===== Download =====
export function startDownload(bv, onProgress) {
  ensureDirs();
  const id = 'bili_' + (++dlId) + '_' + Date.now().toString(36);
  const url = 'https://www.bilibili.com/video/' + bv;
  const outputFile = join(TEMP_DIR, bv + '.mp4');
  const state = { id, bv, status: 'starting', progress: 0, title: '', error: null, outputFile };
  downloads.set(id, state);

  getBiliInfo(bv).then(info => {
    state.title = info.title;
    state.duration = info.duration;
    if (onProgress) onProgress(state);
  }).catch(() => {});

  const cookieStr = getCookieString();
  const args = [
    '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline',
  ];
  if (cookieStr) args.push('--add-headers', 'Cookie: ' + cookieStr);
  args.push('-o', outputFile, url);

  const proc = spawn('yt-dlp', args);
  state.proc = proc;

  proc.stdout.on('data', (data) => {
    const line = data.toString();
    const m = line.match(/(\d+\.\d+)%/);
    if (m) {
      state.progress = parseFloat(m[1]);
      state.status = 'downloading';
      if (onProgress) onProgress(state);
    }
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString();
    if (line.includes('ERROR')) {
      state.error = line.trim();
      state.status = 'error';
    }
  });

  proc.on('close', (code) => {
    if (code === 0 && existsSync(outputFile)) {
      state.status = 'transcoding';
      state.progress = 100;
      const finalFile = join(VIDEOS_DIR, bv + '.mp4');
      const ff = spawn('ffmpeg', ['-y', '-i', outputFile, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', finalFile]);
      ff.stderr.on('data', () => {});
      ff.on('close', (ffCode) => {
        if (ffCode === 0) {
          state.status = 'done';
          state.finalFile = finalFile;
        } else {
          state.status = 'error';
          state.error = 'transcode failed';
        }
        if (onProgress) onProgress(state);
      });
    } else if (code !== 0) {
      state.status = 'error';
      if (!state.error) state.error = 'yt-dlp exited with code ' + code;
      if (onProgress) onProgress(state);
    }
  });

  return state;
}

export function getDownload(id) { return downloads.get(id); }
export function getAllDownloads() { return Array.from(downloads.values()); }

// Init
loadCookies();


const streamUrlCache = new Map(); // bv -> {ts, urls}  yt-dlp回流地址有效期约200s，缓存90s
const STREAM_CACHE_TTL = 90 * 1000;
export function getStreamUrls(bv) {
  const hit = streamUrlCache.get(bv);
  if (hit && Date.now() - hit.ts < STREAM_CACHE_TTL) {
    return Promise.resolve(hit.urls);
  }
  return new Promise((resolve, reject) => {
    const url = "https://www.bilibili.com/video/" + bv;
    const args = [
      "--get-url", "--no-playlist",
      "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
      url
    ];
    const cookieStr = getCookieString();
    if (cookieStr) args.push('--add-header', 'Referer: https://www.bilibili.com/', '--add-header', 'Cookie: ' + cookieStr);
    execFile("yt-dlp", args, { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      const urls = stdout.trim().split("\n").filter(Boolean);
      const u = { videoUrl: urls[0] || "", audioUrl: urls[1] || urls[0] || "" };
      if (u.videoUrl) streamUrlCache.set(bv, { ts: Date.now(), urls: u });
      resolve(u);
    });
  });
}

// ===== 个性化推荐（需登录，返回不同批次） =====
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map(n => orig[n]).join('').slice(0, 32);
}

function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const currTime = Math.round(Date.now() / 1000);
  const chrFilter = /[!'()*]/g;
  params.wts = currTime;
  const query = Object.keys(params)
    .sort()
    .map(key => {
      const value = ('' + params[key]).replace(chrFilter, '');
      return encodeURIComponent(key) + '=' + encodeURIComponent(value);
    })
    .join('&');
  const wbiSign = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return query + '&w_rid=' + wbiSign;
}

async function getWbiKeys() {
  const res = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const data = await res.json();
  if (!data.data?.wbi_img) throw new Error('获取 wbi key 失败 code=' + data.code);
  const imgUrl = data.data.wbi_img.img_url;
  const subUrl = data.data.wbi_img.sub_url;
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0];
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0];
  return { imgKey, subKey };
}

async function getBuvid() {
  try {
    const res = await biliFetch('https://api.bilibili.com/x/frontend/finger/spi');
    const data = await res.json();
    if (data.code === 0) return data.data.b_3 || data.data.b_4 || '';
  } catch {}
  return '';
}

export async function getRecommend(freshIdx = 1) {
  const { imgKey, subKey } = await getWbiKeys();
  const buvid = await getBuvid();
  const params = {
    ps: 20,
    fresh_type: 3,
    fresh_idx: freshIdx,
    homepage_ver: 1,
    buvid,
    wts: 0,
  };
  // 传 buvid cookie，并用已登录 cookie（个性化依赖登录态）
  let cookie = buvid ? 'buvid3=' + buvid + ';' : '';
  if (biliCookies) cookie = getCookieString() + (buvid ? '; buvid3=' + buvid : '');
  const query = encWbi(params, imgKey, subKey);
  const url = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?' + query;
  const res = await biliFetch(url, { headers: { Cookie: cookie } });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'recommend failed');
  // 只保留真正的视频项（过滤 login_card / 广告 / 直播等）
  const list = (data.data?.item || [])
    .filter(v => v.goto === 'av' && v.bvid)
    .map(v => ({
      bvid: v.bvid,
      title: v.title,
      author: v.owner?.name || '',
      duration: v.duration || 0,
      play: v.stat?.view || 0,
      pic: v.pic || '',
      rcmd_reason: v.rcmd_reason?.content || '',
    }));
  return { list, freshIdx };
}

// ===== 我的关注（关注的 UP 列表） =====
export async function getFollowings(page = 1) {
  // 需要自己的 mid
  const nav = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const navData = await nav.json();
  const mid = navData.data?.mid;
  if (!mid) throw new Error('未登录或无法获取 mid');
  const url = 'https://api.bilibili.com/x/relation/followings?vmid=' + mid + '&pn=' + page + '&ps=30&order=desc';
  const res = await biliFetch(url);
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'followings failed');
  const list = (data.data?.list || []).map(u => ({
    mid: u.mid,
    name: u.uname || '',
    sign: (u.sign || '').slice(0, 60),
    face: u.face || '',
    videos: u.videos || 0,          // 视频数（-1 表示未公开）
    fans: u.follower || 0,          // 粉丝数
    official: u.official?.role || 0,
  }));
  return { list, total: data.data?.total || 0, page };
}

// ===== 某 UP 的视频列表（空间投稿） =====
export async function getFollowingVideos(uid, page = 1) {
  const { imgKey, subKey } = await getWbiKeys();
  const params = { mid: uid, pn: page, ps: 30, order: 'pubdate', wts: 0 };
  const query = encWbi(params, imgKey, subKey);
  const url = 'https://api.bilibili.com/x/space/wbi/arc/search?' + query;
  const res = await biliFetch(url);
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'up videos failed');
  const list = (data.data?.list?.vlist || []).map(v => ({
    bvid: v.bvid,
    title: v.title || '',
    author: v.author || '',
    duration: v.length || 0,        // "mm:ss"
    play: v.play || 0,
    pic: v.pic || '',
  }));
  return { list, total: data.data?.page?.count || list.length, page };
}

// ===== 我的收藏（收藏夹列表） =====
export async function getFavorites() {
  const nav = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const navData = await nav.json();
  const mid = navData.data?.mid;
  if (!mid) throw new Error('未登录或无法获取 mid');
  // 合并"创建的"与"收藏的"两个维度都取（用户主要看自己创建的默认夹/自定义夹）
  const byCreated = await biliFetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + mid);
  const cData = await byCreated.json();
  let folders = [];
  if (cData.code === 0) folders = folders.concat(cData.data?.list || []);
  // 收藏的收藏夹（别人公开的）也拼进来；接口可能返回 404/HTML（未收藏他人夹等），需容错
  try {
    const byCollected = await biliFetch('https://api.bilibili.com/x/v3/fav/folder/collected/list-all?up_mid=' + mid);
    const oData = await byCollected.json();
    if (oData.code === 0) folders = folders.concat(oData.data?.list || []);
  } catch {}
  // 去重（按 id）
  const seen = new Set();
  const list = [];
  for (const f of folders) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    list.push({ fid: f.id, title: f.title || '未命名', media_count: f.media_count || 0 });
  }
  if (list.length === 0) throw new Error('收藏夹为空');
  return { list };
}

// ===== 某收藏夹的视频列表 =====
export async function getFavoriteVideos(fid, page = 1) {
  const url = 'https://api.bilibili.com/x/v3/fav/resource/list?media_id=' + fid + '&pn=' + page + '&ps=30&keyword=&order=mtime&type=0&tid=0&platform=web';
  const res = await biliFetch(url);
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'favorites failed');
  const list = (data.data?.medias || []).filter(m => m.bvid).map(m => ({
    bvid: m.bvid,
    title: m.title || '',
    author: m.upper?.name || '',
    duration: m.duration || 0,        // 秒
    play: m.cnt_info?.play || 0,
    pic: m.cover || m.pic || '',
    fav_time: m.fav_time || 0,
  }));
  return { list, total: data.data?.info?.media_count || list.length, page };
}

