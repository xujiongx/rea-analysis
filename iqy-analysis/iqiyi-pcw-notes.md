# 爱奇艺 PCW 首页逆向摘要（研究）

目标：[`https://www.iqiyi.com/`](https://www.iqiyi.com/)

本地实验台：[`code/README.md`](./code/README.md)

## 产品形态

- 名称：爱奇艺 PC Web（PCW）首页 / 频道推荐
- 版本（页面配置）：`17.104.26764`（`window.qy_page_config_*`）
- 前端路径：SSR HTML 壳 + `/static/js|css` 分包；推荐首屏数据走 `prelw` script

## 技术栈（观察）

- React 打包产物：`/static/js/react.*.js`、`iqiyi-pcw-ui`、`iqiyi-sdk`、`qysdk_*`、`libs_*`、`common-channel_*`、`channel_*`
- 播放器：`static.iqiyi.com/js/player_v3/pcweb.phm.js`、`pcweb.mini.17.104.online.js`
- 安全 / 指纹：`security.iqiyi.com/static/cook/v1/cooksdk.js`、`stc.iqiyipic.com/gaze/fingerprint/...`
- 字体 CDN：`static-d.iqiyi.com/pc/fonts/*.woff2`（Harmony / FZ）

## 关键请求面（首页）

同源：

| 路径 | 作用 |
|------|------|
| `/prelw/portal/lw/v7/channel/recommend?...` | 频道推荐 SSR/预取（script 标签） |
| `/pc/player/single/webPlayerConfig.json` | 迷你播放器配置 |
| `/static/**` | 前端静态资源 |

跨域 API（`mesh.if.iqiyi.com` 为主）：

| 路径模式 | 作用 |
|----------|------|
| `/portal/lw/weather/data` | 天气 |
| `/portal/lw/search/keywords/default` | 搜索默认词 |
| `/portal/lw/vip/interact` | VIP 互动 |
| `/portal/lw/v2/popup/**` | 弹窗 |
| `/portal/lw/v5/channel/navigateBar/bubble` | 导航气泡 |
| `/player/pcw/video/playervideoinfo` | 播放信息 |
| `/player/lw/display/control/v2` | 播放展示控制 |
| `/notify/web_push/public_key` | Web Push |

视频相关（研究边界：只观察协议，不破解）：

- `cache.video.iqiyi.com/dash?...` — DASH 清单
- `pcw-data.video.iqiyi.com` / `*.71edge.com` — 分片 CDN

埋点：`*.qy.net`（`amsg` / `bmsg` / `qmsg` / `emsg`）、`otheve.beacon.qq.com`、`rumt-zh.com`

## 本地代理策略

- 前端落盘：`code/frontend/`
- 跨域改写：注入脚本把已知 host 映射到 `/__p/<host>/...`
- 缺失静态 / 同源 API：回源 `www.iqiyi.com`
- 播放页：上游 `accelerator.js` 带 `origin=`；若为 `http://127.0.0.1:8788/...` 会鉴权失败，播放器常误显示「视频已被删除」。代理须把 `Origin`/`Referer`/`origin`/`rpage`(base64) 改回 `https://www.iqiyi.com/...`
- 播放器错误码 `411/491/501` → UI `dash_effective`（「该视频已被删除」）。**不要**把 accelerator / `v.f4v` JSON 里的 CDN URL 改写成 `127.0.0.1/__p/...`（会校验真实 `*.71edge.com` 主机名）；只靠页面注入的 fetch/XHR/media `src` 钩子走 `/__p/`，manifest（m3u8/mpd）正文仍可改写
- **不要**改写 `accelerator.js?disableDRM=`：须与客户端一致
- **不要**改写 accelerator 的 `origin=` 查询参数（可改 Origin/Referer 请求头）；`ev` 内播放地址会随 origin 变化
- 播放页 VIDEOERROR `type=offline` → `error.html?errortype=2`。代理下常为误报且会中断主片 accelerator；JS 改写须禁用 `if("offline"===…){errorCode:2}`，并把 error.html URL 留在本地
- 播放页登录弹窗：`QyLoginInst.openLoginByJs` / `Popup.showLogin`。实验台注入脚本将 `openLoginByJs` 置空，并隐藏含「扫码登录 / 微信快捷登录」的浮层（不碰真实登录鉴权协议）
- 「该视频已被删除」/`dash_effective` 常是假象：播放器把 `st∈{411,491,501}` **以及** 网络/数据/cookie 类失败都画成同一文案。实测 VIP 片（如《围猎》`tvid=1564724759329100`）`accelerator` 可返回 `st=101` 且带 `drmType:1`；未登录 + 不做 DRM/会员绕过时主片仍播不了，预告/广告 `71edge` 能通。研究边界：不破解 DRM、不伪造 VIP 票据
- 广告：实验台屏蔽 `cupid` / `/portal/lw/ad/*`；`accelerator.js` 清空 `a.data.playUrls`/`slots`/`duration`；注入隐藏「跳过广告」等残留 UI。不改主片 `ev` 码流
- 同源 `/prelw/...` 应转发到 `mesh.if.iqiyi.com`，不要打到 `www.iqiyi.com`
- 若日志出现 `read ETIMEDOUT mesh.if.iqiyi.com`，是播放关键接口超时（不是片子真删了）；代理对 `accelerator.js`/`dash` 会加长超时并重试一次。mesh 优先走系统 DNS，避免 IP+SNI 卡在错误 POP
- 播放页 `accelerator.js` 返回的码流在 `*.71edge.com` / `data.video.iqiyi.com`。这些 host 若不走 `/__p/`，浏览器从 `127.0.0.1` 跨域拉流失败，播放器同样显示「已删除」（首页迷你播走 `cache.video.iqiyi.com` 故能播）。代理需：允许 71edge 后缀、改写 accelerator JSON 内 CDN URL、注入脚本匹配后缀 host

## 使用边界

仅架构与前端链路研究
