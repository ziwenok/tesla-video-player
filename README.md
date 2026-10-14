# Tesla 车机浏览器 · 多媒体系统

一个为 **Tesla 车机内置浏览器**（Chrome，Linux/X11）设计的个人媒体服务器。

核心能力：**绕过特斯拉"驾驶模式"对 `<video>` 的冻结限制**，让车机在行车中仍能播放视频，
同时提供 B站、YouTube、音乐、电视直播、大文件上传等模块。

---

## 为什么需要这个项目

特斯拉"D 档"（行驶中）会在系统层冻结 `<video>` 元素——画面卡住、播放停滞。
但实测发现：

| 能力 | 行驶中是否可用 |
|---|---|
| `<video>` / `<video>` 解码 | ❌ 被系统冻结 |
| `<audio>` 音频播放 | ✅ 正常 |
| `<canvas>` 绘制 | ✅ 正常 |
| WebSocket / fetch | ✅ 正常 |

因此本项目的方案是：**服务端用 FFmpeg 解出 JPEG 帧 → WebSocket 推到车机 →
车机用 `<canvas>` 绘制，`<audio>` 作为主时钟驱动画面**。

详见 [REWRITE-2026-10-07.md](REWRITE-2026-10-07.md)，
其中记录了完整的架构设计与 **14 个踩坑实录**。

---

## 功能模块

| 模块 | 页面 | 说明 |
|---|---|---|
| 本地视频 | `player.html` | 服务器视频库，帧流/Cavnas 渲染 + 字幕 |
| B站 | `bili.html` | 搜索、热门、关注、**扫码登录看收藏** |
| YouTube | `youtube.html` | 搜索、综合热门（多品类混合）、扫码登录 |
| 音乐 | `music.html` | 歌词同步、方向盘可控 |
| 电视直播 | `live.html` | 51 个频道，央视/卫视/体育 |
| 大文件上传 | `upload.html` | 切片上传 + 服务端拼合 |

---

## 架构

```
车机浏览器
  ├── <audio>          音频主时钟（听感基准）
  ├── <canvas>         画面绘制（服务端推 JPEG 帧）
  └── WebSocket ────────┐
                        │  4 字节小端 uint32 毫秒时间戳 + JPEG
node server.js          │
  ├── /ws/frames       ←┘  FFmpeg 解帧 → 实时推送
  ├── /api/video/*           本地视频（支持 Range 拖动）
  ├── /api/bilibili/*        B站取流 + 扫码登录
  ├── /api/youtube/*         YouTube（yt-dlp）
  └── /api/upload/*          大文件流式反代
```

**四个视频来源**，均走同一套帧流内核（`public/js/core/frames.js`）：

| 来源 | 取流方式 |
|---|---|
| 本地文件 | FFmpeg 读本地文件 |
| B站 | 先把视频切成 TS 分片到 `videos/.segments`，再当本地文件读 |
| YouTube | `yt-dlp -o - \| FFmpeg -i pipe:0` 管道 |
| 直播 | FFmpeg 拉 HLS/m3u8 |

---

## 关键实现细节

### 1. Tesla D 档绕过

D 档下 `<video>` 被系统冻结，但 `<audio>` 与 `<canvas>` 正常。
因此画面走 Canvas，音频走 `<audio>`，**音频作为主时钟**——

`frames.js` 按音频 `currentTime` 挑选应该呈现的帧，保证"听到哪、看到哪"。

### 2. 车机屏幕的缩放陷阱（重要）

Tesla 固件的 `devicePixelRatio ≈ 1.53`，CSS 视口只有 **773×601**（物理 1254×784）。

这导致两个反直觉的问题：

- **`@media (max-width: 860px)` 会在车机上误触发** —— 明明屏幕很宽，
  却折成上下结构。解决：用 JS 计算 `innerWidth / zoom`，
  驱动 `html[data-tp-layout="wide|stack"]`，不用 CSS media query 判断布局。
- 全局 `zoom: 1/dpr` 后，CSS 里的 media query **不感知 zoom**。

### 3. YouTube 取流（踩坑最集中的地方）

实测 **YouTube 已下线 trending 页面**，且 `yt-dlp` 默认客户端的直链
**要求 Range 头**（FFmpeg 无法按需发送）。

最终方案：`yt-dlp --extractor-args "youtube:player_client=android" -o - | FFmpeg -i pipe:0`，
由 yt-dlp 负责所有请求细节，FFmpeg 从管道解帧。

**但管道模式带来三个连锁问题**，详见文档第 9 节：

| 问题 | 根因 | 解法 |
|---|---|---|
| 音频 30~60 秒才出声 | 等整个 MP3 转码完 | 边转码边发 |
| 帧时间戳飙到上千秒 | 管道不能用 `-re`，FFmpeg 全速解码（6.8x） | 用 `showinfo` 取真实 PTS |
| 画面永远超前音频 | 服务端 6.8 倍速推送 | 流背压限速 |

---

## 网络出口设计（重要）

本项目部署在**双路由环境**下访问 YouTube：

```
192.168.1.1  主路由    —— 公网 NAT，车机从公网回连的**回程路径**靠它
192.168.1.2  旁路由    —— ImmortalWrt + Clash 透明代理
```

> ⚠️ **绝对不要把默认网关改成旁路由。**
> 这会导致车机无法访问（回包出口 IP 与入站路径不一致，TCP 建不起来）。
> 这是本项目的**严重事故复盘**，详见文档第 13 节。

正确做法（`scripts/youtube-exit.sh`）：**按域名分流**，不动默认网关。

- 旁路由的透明代理**无需凭据**，靠两件事协作：
  1. DNS 劫持：用旁路由做 DNS 时，youtube 解析为 fake-IP（`198.18.x.x`）
  2. 流量引流：fake-IP 段路由指向旁路由，它据此识别并代理
- 因此只需：
  - 明细路由 `198.18.0.0/15 via 192.168.1.2`
  - dnsmasq 分流：YouTube 域名走旁路由，**其余走国内 DNS（不绕路）**

这个方案只影响 YouTube 域名，国内站点直连，车机回程完全不受影响。

---

## 安装

```bash
# 1. 安装依赖
npm install

# 2. 准备目录
mkdir -p videos subtitles lyrics music state
touch videos/.gitkeep subtitles/.gitkeep

# 3. 配置（按需修改 .env）
cp .env.example .env

# 4. 启动
npm start
# HTTP  → http://0.0.0.0:3000
# HTTPS → https://0.0.0.0:3443   （需 ssl.crt / ssl.key）
```

### 外部依赖

| 工具 | 用途 |
|---|---|
| `ffmpeg` / `ffprobe` | 帧解码、音频提取、切片 |
| `yt-dlp` | YouTube 取流 |
| `dnsmasq` | YouTube 域名分流 DNS |
| `qrcode` (npm) | 生成扫码登录二维码 |

### YouTube 出口（可选）

若部署环境无法直接访问 YouTube，参考 `scripts/youtube-exit.sh`
配置旁路由分流 DNS + 明细路由。

---

## 目录结构

```
├── server.js             Express + WebSocket 主服务
├── bilibili.js           B站 API 封装（取流/扫码/收藏/关注）
├── youtube.js            YouTube API 封装（yt-dlp）
├── live_channels.json    51 个直播频道列表
├── public/
│   ├── *.html            各功能页面（left-aligned 控制按钮）
│   ├── css/
│   │   ├── tokens.css      设计令牌（颜色/间距/圆角）
│   │   └── app.css         共享组件
│   ├── js/core/
│   │   ├── frames.js      帧流内核（解码/停摆自愈/背压）
│   │   ├── clock.js       音频主时钟
│   │   ├── viewport.js    车机缩放与布局属性
│   │   ├── api.js         fetch 封装（超时/重试）
│   │   ├── dom.js         安全 DOM 构建 + 格式化
│   │   ├── mediactl.js    方向盘/媒体键桥接
│   │   ├── log.js         上报日志
│   │   ├── toast.js       轻提示
│   │   └── webcodecs.js   硬解（实验）
│   └── vendor/           第三方库（ffmpeg.wasm/hls/jsmpeg/mp4box）
├── patches/             历史热修复脚本（幂等，可重复执行）
├── scripts/             部署/维护脚本
└── REWRITE-2026-10-07.md   架构文档 + 14 个踩坑实录
```

---

## 设计约定

### 按钮一律靠左

车机的驾驶员在**左边**，所有控制按钮左对齐
（`.tp-ctl { justify-self: start }`，不留 `.tp-grow` 占位）。

### CSS media query 少用

Tesla 的 `zoom: 0.65` 会让 media query 失效。
布局切换用 **JS 驱动的 `data-tp-layout` 属性**，而非 media query。

### 前端 UI 组件统一用共享设计系统

`css/tokens.css` + `css/app.css` 提供统一令牌与组件，
避免多个页面风格不一致（这正是本项目最初重写的原因）。

---

## 已知限制

| 项 | 说明 |
|---|---|
| YouTube 画质上限 720p | `android` 客户端只给合并格式。车机屏足够，但比 B站 低 |
| YouTube 首帧 10~20 秒 | yt-dlp 取流本身耗时，页面会显示"正在连接 YouTube…" |
| YouTube 无登录态功能 | 收藏/关注需 OAuth，未实现 |
| 直播频道源 | `live_channels.json` 的直播源会失效，需定期更新 |

---

## 安全说明

- **默认所有传入文件名都做路径穿越校验**（`/api/subtitle`、`/api/video`）。
  本项目曾被路径穿越漏洞读出 `/etc/passwd`——因为服务暴露在公网。
- `/api/bilibili/img-proxy` 只代理白名单 host，防 SSRF。
- HTTPS 证书需要自备（自签即可），不入库。

---

##  License

MIT
