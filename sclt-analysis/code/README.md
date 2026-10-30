# 本地前端镜像 + 后端代理

把 `/digital-viewer` 前端静态资源镜像到 `frontend/`，后端接口（`/aicc-api`、`/minio`、WebSocket 等）反向代理到线上。

## 前端镜像

当前仓库已包含镜像产物：`frontend/digital-viewer/`（约 6.4MB，含 JS/CSS/worker/地图等）。清单见 `frontend/mirror-manifest.json`。

若以后资源哈希变了，可在本机终端重新拉取：

```bash
cd analysis/code
UPSTREAM_IP=81.71.197.85 npm run mirror
```

（Agent 沙箱可能因网络策略拉失败；请在系统终端执行。）

## 启动

```bash
UPSTREAM_IP=81.71.197.85 npm start
```

- 入口：http://127.0.0.1:8787/
- 导览：入口页「打开导览深链」

## 行为

| 路径 | 来源 |
|------|------|
| `/digital-viewer/**` | 本地 `frontend/`；缺失时回源补齐 |
| `/aicc-api/**`、`/minio/**`、其他 API 前缀 | 上游代理 |
| WebSocket | 上游代理 |

## DNS

本机 DNS 若解析不了域名，务必带 `UPSTREAM_IP=81.71.197.85`（IP 可能变化，可用 DoH 再查）。
