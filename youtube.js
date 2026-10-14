/* ============================================================================
   YouTube 模块 (youtube.js)
   ----------------------------------------------------------------------------
   与 bilibili.js 同构：搜索 / 取流地址 / 时长 / 音频，供 server.js 的路由调用。

   为什么用 yt-dlp 而不是 YouTube Data API
     · 服务器已装 yt-dlp（B站下载在用），无需申请 API Key、无配额限制。
     · Data API 只能拿元数据，**取流地址仍必须靠 yt-dlp**（YouTube 的签名 URL
       由播放器逻辑生成，API 不提供）。所以统一用 yt-dlp 最简洁。

   关键实测结论（改动前务必先读）
     1. googlevideo.com 的直链**带签名与过期时间**（expire 参数，约 6 小时），
        且签名里绑定了请求方 IP（ip= 参数）。因此：
          · 必须缓存，但 TTL 要短（这里 90 分钟，留足余量）；
          · **不能把直链发给浏览器**（浏览器 IP 与服务端不同，会被拒 403）。
            画面必须走服务端代理/帧流，音频同理。
     2. `ytsearchN:` 前缀可直接搜索，无需 API。
     3. YouTube 已下线 `/feed/trending`（会 302 回首页），所以"热门"用
        一组预置关键词的搜索来代替。
     4. 取流格式优先 h264（avc1）：车机与我们的帧流链路对 H.264 最稳，
        AV1/VP9 在部分解码路径上会出问题。用 -S 排序而不是 -f 硬编码。
   5. **必须指定 `--extractor-args youtube:player_client=android`**（2026-10 实测）：
        · yt-dlp 默认走 ANDROID_VR 客户端，它给的直链**要求带 Range 头**，
          否则 403；而 ffmpeg 无法可靠地按需发 Range → 画面拉不起来。
        · web / ios / tv 等客户端在当前网络下直接取流失败。
        · android 客户端给的直链 ffmpeg 可直接拉取，是唯一稳定可用的。
        代价：android 客户端通常只提供**合并格式**（≤720p，含音轨）。
        对本用途（帧流画面 + 独立音轨）完全够用。
   6. **取流用管道而非直链**：`yt-dlp -o - | ffmpeg -i pipe:0`。
      yt-dlp 自己处理请求头与分段，比把直链交给 ffmpeg 稳健得多
      （直链还会过期、且部分客户端的 URL 对请求方式敏感）。
   ============================================================================ */

import { execFile } from 'child_process';

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';

/**
 * 固定使用 android 客户端（2026-10 实测的唯一稳定选择）。
 * 见文件头注释第 5 条：默认的 ANDROID_VR 直链要求 Range 头，ffmpeg 拉不动；
 * web/ios/tv 在当前网络下取流失败。
 */
const CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=android'];

/** 直链缓存 TTL：YouTube 签名约 6 小时有效，取 90 分钟留足余量。 */
const STREAM_CACHE_TTL = 90 * 60 * 1000;

const streamCache = new Map();   // videoId -> { ts, urls }
const infoCache = new Map();     // videoId -> { ts, info }
const searchCache = new Map();   // key -> { ts, data }

/** 通用 yt-dlp 调用（execFile，argv 数组，不经 shell —— 无注入风险）。 */
function runYtdlp(args, { timeout = 60000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').split('\n')
          .filter(Boolean).slice(-2).join(' / ').slice(0, 300);
        return reject(new Error(msg || 'yt-dlp 执行失败'));
      }
      resolve(String(stdout || ''));
    });
  });
}

/* ── URL / ID 解析 ───────────────────────────────────────────────────────── */

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** 从各种 YouTube URL 或裸 ID 中提取 11 位视频 ID。 */
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (ID_RE.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s);
    const v = u.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    // youtu.be/ID、/shorts/ID、/embed/ID、/live/ID
    const m = /\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
    if (m) return m[1];
    const p = u.pathname.replace(/^\//, '');
    if (ID_RE.test(p)) return p;
  } catch {}
  return null;
}

/* ── 搜索 ────────────────────────────────────────────────────────────────── */

/** 把 yt-dlp 的条目统一成前端要的形状（与 B站页字段对齐）。 */
function normEntry(d) {
  const id = d.id || '';
  const thumb = d.thumbnail
    || (Array.isArray(d.thumbnails) && d.thumbnails.length ? d.thumbnails[d.thumbnails.length - 1].url : '')
    || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '');
  return {
    bvid: id,                    // 复用前端的 bvid 字段名，便于共用渲染逻辑
    id,
    title: d.title || '未命名',
    pic: thumb,
    author: d.uploader || d.channel || d.uploader_id || '',
    play: d.view_count || 0,
    duration: d.duration || 0,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

/**
 * 搜索。keyword 为空时用预置关键词（YouTube 已下线 trending）。
 * @param {string} keyword
 * @param {number} limit 结果数
 */
/**
 * 搜索。
 * @param {string} keyword
 * @param {number} limit
 * @param {object} [opts]
 *   sortByViews {boolean} 按播放量排序（"热门"用）。
 *     `ytsearchN:` 前缀走的是 YouTube 的搜索结果页，**默认按相关度**排序，
 *     实测会返回播放量只有几十的视频（关键词被低质搬运号占据）。
 *     改用搜索结果 URL + `sp=CAM%3D`（按播放量排序）后，播放量从几十
 *     跃升到百万级 —— 这才是"热门"应有的质量。
 */
export async function searchYouTube(keyword, limit = 20, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('缺少搜索关键词');

  const n = Math.max(1, Math.min(40, parseInt(limit, 10) || 20));
  const byViews = !!opts.sortByViews;
  const key = `${kw}|${n}|${byViews ? 'v' : 'r'}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.data;

  // 按播放量排序走搜索 URL（ytsearchN: 无法指定排序）
  const target = byViews
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(kw)}&sp=CAM%3D`
    : `ytsearch${n}:${kw}`;

  const out = await runYtdlp([
    '--no-warnings', '--ignore-errors',
    ...CLIENT_ARGS,
    '--dump-json', '--flat-playlist',
    '--playlist-end', String(n),
    target,
  ], { timeout: 120000 });

  const list = [];
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const v = normEntry(JSON.parse(s));
      /* 统一过滤（对所有调用方生效：热门 / 分类页 / 搜索框）。
         用户要求"都要中文的节目"，实测各品类结果都会混入外文内容，
         且按播放量排序时历史高播放的老视频会排到前面。 */
      if (!isChineseTitle(v.title)) continue;
      if (isTooOld(v.title)) continue;
      list.push(v);
    } catch {}
  }
  const data = { list, keyword: kw };
  searchCache.set(key, { ts: Date.now(), data });
  // 防无界增长
  if (searchCache.size > 60) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) searchCache.delete(oldest[0]);
  }
  return data;
}

/**
 * "热门"。
 *
 * 背景：**YouTube 已下线 trending 页面**（`/feed/trending`、`/feed/explore`
 * 全部 302 回首页，各种 URL 形式与客户端都试过，实测均失败），所以只能用
 * 搜索近似。
 *
 * 但**不能用单一关键词** —— 中文 YouTube 上"热门/歌曲"这类词的搜索结果
 * 被音乐搬运号占据，会得到清一色歌单（这正是"热门里全是歌曲"的原因）。
 *
 * 做法：**多品类并行取，交错混合**。
 *   · 每个品类用"该品类 + 本周/热门"这类组合词，避免被泛词带偏；
 *   · 并行搜索后按品类轮流取值（round-robin），保证首页品类均衡；
 *   · 每次调用轮换品类起点，让"换一批"有新鲜内容。
 */
const HOT_CATEGORIES = [
  { key: 'news',   kw: '本周 新闻 热点' },
  { key: 'mil',    kw: '军事 装备 解析' },      // 军事（用户指定；实测此词中文占比最高）
  { key: 'pol',    kw: '时政 分析' },          // 时政（用户指定）
  { key: 'tech',   kw: '科技 数码 评测' },
  { key: 'game',   kw: '游戏 实况 热门' },
  { key: 'movie',  kw: '电影 解说 热门' },
  { key: 'food',   kw: '美食 探店' },
  { key: 'travel', kw: '旅行 vlog' },
  { key: 'sport',  kw: '体育 赛事 集锦' },
  { key: 'sci',    kw: '科学 科普 2026' },     // 加年份，避免儿童科普动画
  { key: 'auto',   kw: '新车 试驾' },           // 用"新车"避开玩具车开箱
];

let hotRotate = Math.floor(Math.random() * HOT_CATEGORIES.length);

/* ── 中文过滤 ──────────────────────────────────────────────────────────────
   用户要求"都要中文的节目"。实测各品类的搜索结果会混入大量外文内容
   （英文旅行 vlog、日文/马来文汽车评测等），例如：
     "Does Eating Beef Bowls in Japan Mean You're Poor?"
     "[BTS VLOG] V l DRIVE VLOG"
     "Italy Travel Vlog: exploring Florence, Tuscany"
   这里按**中文字符占文字字符的比例**过滤：>= 45% 视为中文内容。

   只统计"文字类"字符（中文/拉丁字母/假名/谚文），忽略数字、符号、emoji ——
   否则标题里的 emoji 和数字会稀释比例，误伤中文视频。
   中英混排且英文为主的标题会被剔除，这是期望行为。 */
const ZH_MIN_RATIO = 0.45;

/**
 * 是否为"过老"内容。
 *
 * "热门"应包含近期内容。实测按播放量排序时，历史高播放量的老视频会排到前面
 * （例如军事品类出现 2013 年的《锵锵三人行》）。
 *
 * 判据：标题里出现明显早于当前的年份（超过 maxAgeYears），且**没有**近期年份。
 *   · 标题含年份 → 用年份判断（如 "20130911 锵锵三人行"、"2018 KKBOX"）
 *   · 标题不含年份 → 不判老（无法从标题得知，交给排序）
 * 这样只剔除"明确标了老年份"的，避免误伤。
 */
function isTooOld(title, maxAgeYears = 3) {
  const t = String(title || '');
  const years = (t.match(/(?:19|20)\d{2}/g) || [])
    .map(Number)
    .filter((y) => y >= 1990 && y <= 2100);
  if (!years.length) return false;
  const cur = new Date().getFullYear();
  // 只要有一个近期年份，就认为不是老内容
  if (years.some((y) => cur - y <= maxAgeYears)) return false;
  return years.some((y) => cur - y > maxAgeYears);
}

function isChineseTitle(title) {
  const t = String(title || '');
  const zh = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const kana = (t.match(/[\u3040-\u30ff]/g) || []).length;   // 日文假名
  const hangul = (t.match(/[\uac00-\ud7af]/g) || []).length;  // 韩文
  const total = zh + latin + kana + hangul;
  if (total === 0) return false;
  return zh / total >= ZH_MIN_RATIO;
}

/** 按品类并行搜索并交错混合（round-robin），保证结果品类均衡。 */
export async function getYouTubeHot(limit = 20) {
  const n = Math.max(4, Math.min(40, parseInt(limit, 10) || 20));
  // 每个品类多取一些：过滤掉非中文后会变少，多取保证最终数量够
  const per = Math.max(6, Math.ceil(n / HOT_CATEGORIES.length) * 2);

  // 轮换起点，让"换一批"换口味
  const cats = HOT_CATEGORIES.map((_, i) =>
    HOT_CATEGORIES[(hotRotate + i) % HOT_CATEGORIES.length]);
  hotRotate = (hotRotate + 1) % HOT_CATEGORIES.length;

  const results = await Promise.all(cats.map(async (c) => {
    try {
      const d = await searchYouTube(c.kw, per, { sortByViews: true });
      return { cat: c, list: d.list || [] };
    } catch {
      return { cat: c, list: [] };   // 单个品类失败不影响整体
    }
  }));

  // round-robin 交错
  const mixed = [];
  const seen = new Set();
  for (let i = 0; i < per && mixed.length < n; i++) {
    for (const r of results) {
      const v = r.list[i];
      if (!v) continue;
      const id = v.id || v.bvid;
      if (!id || seen.has(id)) continue;
      // 中文/老内容过滤已在 searchYouTube 内完成
      seen.add(id);
      mixed.push({ ...v, _cat: r.cat.key });
      if (mixed.length >= n) break;
    }
  }

  const ok = results.filter((r) => r.list.length).map((r) => r.cat.key);
  return { list: mixed, categories: ok, keyword: '综合热门' };
}

/* ── 视频信息 / 时长 ─────────────────────────────────────────────────────── */

export async function getYouTubeInfo(idOrUrl) {
  const id = parseYouTubeId(idOrUrl);
  if (!id) throw new Error('无效的 YouTube 视频 ID');

  const hit = infoCache.get(id);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.info;

  const out = await runYtdlp([
    '--no-warnings', ...CLIENT_ARGS, '--dump-json', '--no-playlist',
    `https://www.youtube.com/watch?v=${id}`,
  ], { timeout: 90000 });

  const d = JSON.parse(out.split('\n').find((l) => l.trim().startsWith('{')) || '{}');
  const info = {
    ...normEntry(d),
    description: String(d.description || '').slice(0, 500),
    duration: d.duration || 0,
  };
  infoCache.set(id, { ts: Date.now(), info });
  if (infoCache.size > 200) {
    const oldest = [...infoCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) infoCache.delete(oldest[0]);
  }
  return info;
}

export async function getYouTubeDuration(idOrUrl) {
  const info = await getYouTubeInfo(idOrUrl);
  return { duration: info.duration || 0, title: info.title };
}

/* ── 取流地址 ────────────────────────────────────────────────────────────── */

/**
 * 取视频/音频直链。
 *
 * 格式选择：优先 H.264（avc1）+ m4a。
 *   车机的帧流链路（服务端 ffmpeg → JPEG）与 WebCodecs 路径对 H.264 最稳；
 *   AV1/VP9 在部分解码路径上会失败。用 -S 表达偏好而非硬编码 -f，
 *   这样即使某视频没有 avc1 也能退到其它格式而不是直接失败。
 *
 * 返回 { videoUrl, audioUrl, duration, title, id }
 */
export async function getYouTubeStreamUrls(idOrUrl) {
  const id = parseYouTubeId(idOrUrl);
  if (!id) throw new Error('无效的 YouTube 视频 ID');

  const hit = streamCache.get(id);
  if (hit && Date.now() - hit.ts < STREAM_CACHE_TTL) return hit.urls;

  const out = await runYtdlp([
    '--no-warnings', '--no-playlist',
    ...CLIENT_ARGS,
    '-f', 'best[height<=720]/best',
    '-S', 'vcodec:h264,res:720',
    '--get-url',
    `https://www.youtube.com/watch?v=${id}`,
  ], { timeout: 90000 });

  const urls = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('http'));
  if (!urls.length) throw new Error('取流失败：yt-dlp 未返回地址');

  // yt-dlp 会按 -f 的顺序输出：第一行视频，第二行音频（若为合并格式则只有一行）
  const result = {
    id,
    videoUrl: urls[0],
    audioUrl: urls[1] || urls[0],
    single: urls.length === 1,
  };
  streamCache.set(id, { ts: Date.now(), urls: result });
  return result;
}

/* ── 缓存清理 ────────────────────────────────────────────────────────────── */

export function clearYouTubeCache() {
  streamCache.clear();
  infoCache.clear();
  searchCache.clear();
}

export function youTubeCacheStats() {
  return {
    stream: streamCache.size,
    info: infoCache.size,
    search: searchCache.size,
  };
}
