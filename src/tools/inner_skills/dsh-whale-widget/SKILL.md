# dsh-whale-widget（鲸鱼娘记账挂件 · DSH → seek-agent 移植）

把 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（标准 DSH bundle 插件）
迁移到 seek-agent 的 Electron 界面右下角。

## 目录结构

```
dsh-whale-widget/
├── enable.json      总开关（enable: false = 整体卸载）
├── index.ts         本 skill 的入口，只导出一个状态查询工具
├── shim.mjs         假 DSH 宿主壳（给插件提供 ctx）
└── widget/          dsh-whale-widget 原包，原样保留
    ├── lib/index.js     插件宿主本体（222KB，不 import 任何 dsh 包，全靠 ctx 注入）
    ├── lib/accounting.mjs  记账内核
    └── assets/          前端 whale-widget.js（862KB）+ 鲸鱼娘图片 / 音效
```

## 原理：假 DSH 宿主

`widget/lib/index.js` 是 DSH 插件，但它的所有 DSH 依赖都走注入进来的 `ctx`。`shim.mjs`
实现一个最小 ctx 把它原样跑起来：

- `webServer.register({kind,path,handler})` → 挂到 `http.createServer`（handler 就是标准 `(req,res)`）
- `webServer.tapIndex(fn)` → 页面注入
- `credentials.resolve/set/delete` → 读写本地凭据文件
- `on('session/event')` → 接收主进程转发的每轮 usage，插件据此算账
- `effect` / `inject` / `get` → 生命周期与可选服务（插件对可选服务都有 fallback）

## 宿主托管

真实宿主在 `electron/main.js`：

1. 读取本目录 `enable.json`，`enable: false` 则不启动
2. 用 `shim.mjs` 加载 `widget/lib/index.js`，起本地 HTTP server（127.0.0.1 随机端口）
3. 把 `widget/assets/whale-widget.js` 注入渲染层（`/dsh-whale/` URL 重写到宿主端口）
4. 监听 agent 发来的 `{ type: 'usage' }` 消息，转成 DSH 的 `assistant/message` + `turn/end` 事件喂给插件

## 卸载

把 `enable.json` 的 `enable` 改成 `false`（`reload_skills` 后生效），或直接删除本目录。
