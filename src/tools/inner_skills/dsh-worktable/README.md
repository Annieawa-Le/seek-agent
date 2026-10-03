# dsh-worktable（工作台 · seek-agent 移植版）

> 上游：[Aisland-SJL/dsh-worktable](https://github.com/Aisland-SJL/dsh-worktable)（MIT，DSH Web 的 Cordis 插件）。
> 本目录是它在 seek-agent 里的自包含移植，遵循本仓库既有的「挂件插件」约定。

## 这个插件干什么

- **侧边栏「工作台」抽屉**：收纳 agent 级项目（改名 / 图标 / 排序占位 / 项目文件夹），
  每个项目可**绑定一个会话**，点项目即切到那个会话。
- **工作台舞台**：主区左侧的分栏工作区，**把宿主会话区挤到右侧当聊天窗**（给 `#main-content`
  加左内边距实现，关闭时还原）。布局预设（单窗格 / 左右两栏 / 三栏 / 顶两窗+主一窗）、
  窗格拖拽分割、每窗格多标签；窗格内容现有 资源管理器 / 文件只读预览 / 项目信息 / 控制室。
- **控制室**：内置默认项目（固定首位、不可删除），卡片网格实时镜像所有会话的
  「工作中 / 空闲 / 当前」状态，**零模型调用**（数据来自宿主会话列表与存活进程列表）。

## 目录结构

```
dsh-worktable/
  enable.json          开关与元信息（设置面板「插件」板块读取）
  host.mjs             宿主半区：本地 HTTP 资源托管（由主进程动态 import）
  client/worktable.js  前端：注入渲染层执行（DOM 挂载）
  README.md            本文件
  upstream/            （可选）上游源码参考，不参与运行
```

## 主进程侧的接入点（electron/main.js）

只有「哑壳」三处，全部可随目录消失而失效：

1. `startWorktable()` —— 读 `enable.json`，`enable !== false` 时 **动态 import** `host.mjs`
   并起本地服务（`enable.json` 不存在或 import 失败都被 catch，不影响主功能）。
2. `did-finish-load` 时 `injectWorktable(win)` —— 读 `client/worktable.js` 注入渲染层。
3. `listWidgetPlugins()` 的 `WIDGET_PREFIXES` —— 让设置面板能列出/开关本插件。

## 卸载方式（整体、干净）

任选其一，**都不需要改回主进程代码**：

- 设置面板 →「插件」→ 关掉「工作台」：写回 `enable.json` 的 `enable: false`，重启后不启动也不注入。
- 直接删除整个 `src/tools/inner_skills/dsh-worktable/` 目录：`enable.json` 不存在 → 不启用；
  动态 import 找不到文件 → 被 catch，主进程照常跑。

删掉后设置面板里不再出现该插件条目，界面无残留（状态只在浏览器 localStorage 的
`dsh.worktable.*` 键下，清掉即净）。

## 与上游的移植差异（为什么不是照搬）

上游是「宿主路由 + web 客户端 bundle 走 slot 协议注入」的双半结构，客户端与 DSH 的
组件树、会话服务、DOM 根结构强耦合。这里按 seek-agent 的实际结构重新落地：

| 上游做法 | 本移植做法 |
|---|---|
| `@deepseek-ai/*` slot 协议进宿主 React 树 | 纯 DOM 挂载 + `MutationObserver` 自愈重挂（宿主重渲染冲掉即补回） |
| DOM 锚点把分栏引擎挤进 DSH 会话根（0.1.1 / 0.1.2 两套结构） | 宿主主区是我们自己的 React，M1-b 直接按 `#main-content` 布局挤，不需要锚点探测 |
| 经宿主会话服务适配层切会话/发消息 | DOM 桥：点宿主自己的会话条目 /「新建会话」按钮，复用宿主 App 的完整切换路径 |
| 宿主 HTTP 路由 `/api/worktable/*`（fs/git/site/term） | 前端直接用 `window.electronAPI`（preload 已暴露会话与文件能力）；`host.mjs` 只保留本地资源与将来的站点托管 |
| 客户端 React bundle（自带 xterm/markdown-it/highlight.js） | M1 用零依赖原生 JS 实现；是否引入构建搬 React 组件见 M3 |

## 当前进度

- **M1-a（已落地）**：插件骨架与注入链、侧边栏抽屉（项目增删改 + 项目↔会话绑定）、
  主区舞台、控制室卡片网格。
- **M1-b（已落地）**：分栏引擎——布局模型与持久化（`dsh.worktable.layouts.v1`）、
  挤法（舞台占左 + 会话区缩到右侧，宽度双向夹紧）、行/窗格/标签三层渲染、
  舞台宽度与窗格宽度拖拽、窗格内容渲染器（类型选择器 / 资源管理器 / 文件只读预览 /
  项目信息 / 控制室）、目录与文件内容缓存（避免轮询重建时反复读盘）。
- **M2**：终端（seek-agent 无 node-pty，需先定降级方案）、浏览器/动画（WebContentsView 或 iframe）、
  项目内静态站点托管。
- **M3**：是否引入构建把上游 React 组件搬进来，以及自定义窗口的 `widget-result.json` 产物握手。

## 自检

- 主进程：node --check electron/main.js
- 宿主半区：node --check src/tools/inner_skills/dsh-worktable/host.mjs
- 前端：node --check src/tools/inner_skills/dsh-worktable/client/worktable.js
- 运行期：启动 Electron 后主进程 stdout 应出现 `[worktable] 宿主已启动`、`[worktable] 前端已注入`，
  以及渲染层回执三行（主进程会转发渲染层 console）：
  - `[worktable] 已挂载：抽屉在侧边栏内 / 舞台在主区内 / 项目 N 个 / 会话 N 个`
  - `[worktable] 布局自检：默认 2 栏 → 三栏 3 → 顶两窗+主一窗 2+1 → 回两栏 2 · 宽度夹紧上限 Npx · 挤法实测 分栏 Npx / 会话区左内边距 Npx`
  - 舞台开着时另有 `[worktable] 舞台：<项目> · 预设 … · 窗格 … · 分栏 …px · 会话区左内边距 …`

  布局自检是真跑一遍布局模型（含 `applyShift` 探测，同步执行不产生绘制帧、不留状态），
  所以不点界面也能确认这批逻辑没炸。

  注意：跳过 `scripts/dev-electron.mjs`（它的 vite 就绪正则会被 ANSI 颜色码打断，必超时），
  手动起：`cd electron/renderer && npx vite --port 5173 --strictPort`，
  另开窗口 `set VITE_DEV_URL=http://localhost:5173&& npx electron .`
