/* ============================================================================
   核心 · 服务端 API 客户端 (core/api.js)
   ----------------------------------------------------------------------------
   重写前每个页面各写一套 fetch 包装，错误处理各不相同：有的静默吞掉，
   有的把服务端返回的 {ok:false,error} 当成成功继续走，导致页面显示
   "加载中..." 永不结束。这里统一：
     · 网络/HTTP 错误 → 抛 ApiError（页面统一 catch 后提示）
     · 服务端业务错误 {ok:false,error} → 抛 ApiError（同上）
     · 需要登录的接口返回 needLogin 时抛特定错误，页面据此弹扫码框
   ============================================================================ */

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', needLogin = false, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.needLogin = needLogin;
    this.body = body;
  }
}

/** 把服务端错误码翻成人话（车机上用户只看得到这几句）。 */
function friendly(msg) {
  if (!msg) return '未知错误';
  if (/风控|412/.test(msg)) return 'B站接口被限流，稍后再试';
  if (/not_logged_in|needLogin/i.test(msg)) return '需要先登录';
  if (/timeout|超时/i.test(msg)) return '请求超时，请重试';
  if (/ECONNREFUSED|fetch failed|NetworkError/i.test(msg)) return '无法连接服务端';
  return String(msg);
}

const DEFAULT_TIMEOUT = 20000;

/**
 * 请求并解析 JSON。
 * @param {string} path
 * @param {object} [opts] fetch 选项 + { timeout, okKey }
 *   okKey: 默认 'ok'。服务端返回该字段为 false 时视为业务错误。
 */
export async function api(path, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, okKey = 'ok', ...rest } = opts;
  const ac = new AbortController();
  const timer = timeout ? setTimeout(() => ac.abort(), timeout) : 0;

  let res;
  try {
    res = await fetch(path, { ...rest, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new ApiError('请求超时', { code: 'timeout' });
    throw new ApiError('无法连接服务端', { code: 'network' });
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  const text = await res.text().catch(() => '');
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (!res.ok) {
    throw new ApiError(friendly(body && body.error) || `HTTP ${res.status}`, {
      status: res.status, body,
      needLogin: !!(body && body.needLogin),
    });
  }

  // 业务层错误：服务端约定 {ok:false, error, needLogin?}
  if (body && typeof body === 'object' && okKey in body && body[okKey] === false) {
    throw new ApiError(friendly(body.error) || '请求失败', {
      status: res.status, body,
      needLogin: !!body.needLogin,
      code: body.error || '',
    });
  }

  return body;
}

export const getJSON  = (path, opts) => api(path, opts);
export const postJSON = (path, data, opts) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data ?? {}),
  ...opts,
});

/** 拼查询串（跳过 null/undefined/空串）。 */
export function qs(params) {
  const s = Object.entries(params || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return s ? '?' + s : '';
}

/* ── 版本角标（全站统一，替代各页面自己 fetch 一遍） ────────────────────── */

export async function showVersionBadge() {
  if (document.getElementById('tpVerBadge')) return;
  const b = document.createElement('div');
  b.id = 'tpVerBadge';
  document.body.append(b);
  try {
    const d = await getJSON('/api/version', { timeout: 6000 });
    if (d && d.version) b.textContent = d.version;
  } catch {}
}
