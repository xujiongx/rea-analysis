# 本地前端镜像 + 多域名后端代理

把 [www.iqiyi.com](https://www.iqiyi.com/) PC 首页壳与 `/static` 资源镜像到 `frontend/`，同源接口回源，跨域 API/CDN 经 `/__p/<host>/...` 代理（页面注入改写 `fetch` / `XHR`）。

**仅研究用途。** 不做 DRM 绕过、鉴权破解或盗链播放。

## 前端镜像

```bash
cd iqy-analysis/code
npm run mirror          # python3 mirror-frontend.py（DoH + SNI）
# 或：UPSTREAM_IP=23.52.40.72 npm run mirror
```

产物：`frontend/`（`index.html`、`static/`、`_cdn/`），清单见 `frontend/mirror-manifest.json`。Agent 沙箱若 `EPERM`，请在系统终端执行。

## 启动

```bash
npm start
# DNS 不通时：
UPSTREAM_IP=23.52.40.72 npm start
```

| 入口 | 说明 |
|------|------|
| http://127.0.0.1:8788/ | 镜像首页（注入 API 改写） |
| http://127.0.0.1:8788/lab | 实验台说明 |
| http://127.0.0.1:8788/healthz | 健康检查 |

## 行为

| 路径 | 来源 |
|------|------|
| `/`、`/static/**` | 本地 `frontend/`；缺失时回源 `www.iqiyi.com` |
| `/v_*.html`、频道页等 | 回源 HTML，并改写 `www.iqiyi.com` 链接 / `Location` 到本机 |
| `/prelw/**`、`/pc/**` 等 | 上游 `www.iqiyi.com` |
| `/__p/<host>/**` | 上游对应 host（mesh / static / pic…） |

注入脚本还会把点击跳转、`location`、`window.open`、`fetch`/`XHR` 里的爱奇艺页面域名改到本机。

播放页码流 CDN（`*.71edge.com`、`data.video.iqiyi.com`）也会进 `/__p/`；`accelerator.js` 响应里的绝对 URL 会被改写，否则会出现「视频已删除」假象。

## REA 抓包（可选）

需本机 Chrome；在仓库根目录有 `rea-agents`：

```bash
npm run capture:rea
```

Evidence 写入 `capture/rea-home-capture.json`。

## DNS

脚本默认系统 DNS，失败则 Google DoH。Agent 沙箱若拉资源失败，请在系统终端执行 `npm run mirror`。
