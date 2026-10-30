# 深圳科学技术馆「小科」导览站逆向摘要

目标 URL（guideAgent 深链）:

`https://sclt-ai.qnzsai.com/digital-viewer/guideAgent/<token>`

本地反向代理实验台（方案 C，不落盘上游产物）：见 [`code/README.md`](./code/README.md)。

## 产品形态

- 名称：小科（数字人导览）
- 场景：深圳科学技术馆室内导览 / 自动播报 / 语音问答 / 识物 / 地图
- 前端路径：`/digital-viewer/` + 路由 `guideAgent/:id`

## 技术栈

- UmiJS + React + Ant Design（样式 token / Modal / Icon）
- Webpack chunk 名：`webpackChunk_aicc_srb_engine`
- 室内地图：Fengmap（`.fmap` 楼层数据 F1–F5）
- 加密：CryptoJS AES-CBC PKCS7
- Worker：`bleProcessor.worker.js`（蓝牙信标）、`audioMerge.worker.js`（音频合成）

## URL Token

路径段经 `decodeURIComponent` 后，用 AES 解密再 `JSON.parse`。

明文结构：

```json
{"eid":"547577334","did":"1996861959131258882","env":"prod"}
```

字段含义（由前端使用方式推断）：

- `eid` → enterpriseId
- `did` → robotId / 数字人配置 id（请求里的 `id=`）
- `env`：`develop`→environment=1，否则 →2（prod）

AES 参数（前端硬编码，JeecgBoot 常见默认值）：

- key/iv 材料：`JEECGBOOT1423670`
- mode：CBC，padding：Pkcs7

## 后端 API 前缀

配置对象（webpack 模块）：

- `crmPrefix`: `/aicc-api`
- `sdmMessagePrefix`: `/aicc-sdm-messageproxy`
- `talkBotPrefix`: `/aicp-talking-bot`
- `asrhelper`: `/aicp-asr-helper`
- `resourcePrefix`: `/min...`（静态资源）

开发代理目标主机名出现在包内：`sclt-dev.qnzsai.com`

- 配置类多为 `noAuth`（仍需 `timestamp` + `sign`）

已观察到的启动请求：

1. `GET /aicc-api/srb/digitalRobotConfig/noAuth/base/detail?id=...&environment=2&type=1&timestamp=...&sign=...`
2. `GET /aicc-api/srb/digitalHuman/noAuth/v2/getSceneAction?timestamp=...&sign=...`（数字人场景动作，体积大）
3. `GET /aicc-api/srb/digitalRobotConfig/noAuth/bluetoothConfigDetail?id=...&environment=2&language=chs&...`
4. `GET /aicc-api/srb/digitalRobotConfig/noAuth/routeConfigNewDetail?id=...&environment=2&type=1&...`

地图静态资源：

- `/digital-viewer/data/<mapId>/<mapId>.scene.fmap`
- `/digital-viewer/data/<mapId>/<mapId>.floor.F{n}.geo.fmap` / `.biz.fmap`
- theme：`/digital-viewer/data/theme/<themeId>/<themeId>.theme`

## 请求签名（概要）

共享包中的签名函数：

1. 写入 `timestamp`（毫秒）
2. 临时写入 `X-Access-Token`（或变体 `S-Access-Token`）与 `X-Access-Path`
3. 对参数 key 排序，拼 `k=v&...`（跳过 `sign` 与空字符串）
4. `MD5(canonical).toUpperCase()` → `sign`
5. 从对外参数中删除临时 Token/Path 字段，保留 `sign`

Token 来源：`localStorage.token`（匿名进页可为空串仍参与拼接）。

## 实时语音

WebSocket：

`wss://{host}{crmPrefix}/srbasrhelper/gomedia/talkbot/guide_websocket?<params>`

params 含 toneId、isLive、deviceId、timestamp 等；并兼容 `window.Android.setWebsocket` 的 App WebView 桥。

## 主要页面能力

- 推荐问句快捷入口
- 长按麦克风语音问答（getUserMedia + ASR WS）
- 蓝牙接近展项自动播报（BLE worker + bluetoothConfig）
- 底栏：展品 / 服务 / 地图 / 识物
- 路线导览（routeConfig）与偏航弹窗

## 静态入口文件

- `framework.*.js` / `umi.*.js` / `preload_helper.*.js`
- 页面包：`p__GuideAgent__index.*.async.js`
- 地图：`fengmap-build-fengmap_map_min_js-lib.*.async.js`
