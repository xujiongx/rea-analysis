# rea

本地前端镜像与多域名代理实验台，配合 [rea-agents](https://www.npmjs.com/package/rea-agents) 做 Web 产品架构 / 链路研究。

**仅研究用途。** 不做 DRM 绕过、鉴权破解或盗链播放。

## 目录结构

| 路径 | 说明 |
|------|------|
| `iqy-analysis/` | 爱奇艺 PCW 首页逆向笔记 + 本地镜像 / 代理实验台 |
| `sclt-analysis/` | `/digital-viewer` 前端镜像 + 后端代理 |
| `my-env/` | 由 REA 从网络抓包导出的 agent environment |
| `demo-app/` | 简易本地演示服务 |
| `scripts/` | HAR 录制、环境构建等辅助脚本 |

## 环境要求

- Node.js ≥ 22（爱奇艺实验台）
- Python 3（可选，用于 `mirror-frontend.py`）
- 本机 Chrome（可选，REA 抓包）

根目录依赖：

```bash
npm install
```

## 快速开始

### 爱奇艺 PCW 实验台

详见 [`iqy-analysis/iqiyi-pcw-notes.md`](./iqy-analysis/iqiyi-pcw-notes.md) 与 [`iqy-analysis/code/README.md`](./iqy-analysis/code/README.md)。

```bash
cd iqy-analysis/code
npm run mirror    # 镜像前端到 frontend/
npm start         # http://127.0.0.1:8788/
```

DNS 不通时可指定上游 IP：

```bash
UPSTREAM_IP=<ip> npm start
```

### digital-viewer 实验台

详见 [`sclt-analysis/code/README.md`](./sclt-analysis/code/README.md)。

```bash
cd sclt-analysis/code
UPSTREAM_IP=<ip> npm start   # http://127.0.0.1:8787/
```

### REA agent environment

详见 [`my-env/README.md`](./my-env/README.md)。使用根目录的 `rea-agents` 按该说明 serve / replay。

## 使用边界

- 观察协议与前端链路，不破解 DRM / 不伪造会员票据
- 镜像与代理产物仅供本地分析，请勿用于未授权访问或传播受版权保护内容
