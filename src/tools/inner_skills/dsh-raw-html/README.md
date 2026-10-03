# dsh-raw-html（视觉卡片 · seek-agent 移植版）

让 AI 在回复正文里直接写裸 HTML，界面把它渲染成视觉卡片——杂志风排版、书法字体、
KaTeX 公式、Mermaid 图表、SVG，**流式逐段长出**；可运行的小程序走隔离沙箱；
写卡前先从 12 套美学风格库里检索。

上游：`dsh-raw-html-v2`（DSH Web 的 Cordis 插件，以官方 slot API 替换 `assistant-step` 渲染器）。
本目录是它在 seek-agent 里的重新落地。

## 落地结构

```
dsh-raw-html/
├── enable.json              总开关（enable / trusted）
├── host.mjs                 宿主半区：本地 HTTP 静态托管（主进程动态 import）
├── index.ts                 agent 侧工具：style_list / style_get / raw_html_status
├── translation.ts           工具调用标签
├── SYSTEM_INJECTION.md      协议注入（写卡规范 + 程序页 + 美学检索；自动进 system prompt）
├── client/
│   ├── raw-html.js          前端：注册扩展点 + 切段 + 引擎装载 + 沙箱调度
│   ├── sandbox-frame.js     隔离运行页（脚本只在沙箱文档里执行）
│   ├── sandbox-frame.html   沙箱页壳（含 CSP）
│   └── engine-boot.js       引擎自注册片段（宿主在引擎响应尾部追加）
├── assets/
│   ├── vendor/              渲染引擎 v1 + KaTeX + Mermaid + 色引擎（3.3MB）
│   └── fonts/               内置字体 9 款（14.5MB，@font-face 由宿主 /fonts.css 产出）
├── styles/                  美学风格库（12 套 + _INDEX + _FONTS + _BASELINE）
└── scripts/                 验收脚本（boot / m2m3 / sandbox-live）
```

## 三期能力

| 期 | 内容 | 执行面 |
|---|---|---|
| M1 | 静态卡片（HTML/CSS/SVG/KaTeX/Mermaid/字体，流式增量） | 渲染层主文档，**卡内脚本不执行** |
| M2 | 整页程序页 + 可信卡片（卡内 `<script>`） | **iframe 沙箱**（`allow-scripts`，opaque origin） |
| M3 | 美学风格库（12 套）+ `style_list` / `style_get` 检索 | agent 侧只读文件 |

## 与上游的关键差别

| 维度 | 上游（dsh-raw-html-v2） | 本移植版 |
|---|---|---|
| 接入点 | 官方 slot API 替换 `assistant-step` | 渲染层**中立内容扩展点**（`utils/content-extension.ts`） |
| 渲染层知识 | 认识 DSH slot 体系 | 对 VCP 协议**零知识**，无注册者时走原 markdown |
| 引擎加载 | 同步 XHR + `new Function('vc','hp','f', src)` | 动态 `<script>` + 宿主尾部追加 `engine-boot.js` |
| 资源路由 | DSH 宿主 `/vendor-v2` `/fonts-v2` | 插件自带本地 HTTP 宿主（`host.mjs`） |
| 字体 | 27 款 + 外置大库扫盘 | 内置 9 款，无外部字体根依赖 |
| **脚本执行** | `(0,eval)` **主文档直接跑**（可够到宿主 API） | **iframe `sandbox="allow-scripts"`**（不透明源，够不到父页/宿主） |
| 风格库 | `styles/*.md` 路径交给 agent 自行 read | 落为 `style_list` / `style_get` 工具（slug 白名单） |
| 开关 | Host 侧持久化 + 浏览器 localStorage 双开关 | `enable.json`（enable / trusted） |

## 安全模型（M2 的重点）

上游可信模式把卡内脚本 `(0,eval)` 在主文档执行。在 DSH Web 里这只是页面脚本；但在 Electron
渲染层，`preload` 暴露了 `sendInput` / `setWorkdir` / `undoPatch`——脚本一跑就等于拿到了改本机
工作区的能力。本移植版把执行面整体挪进 iframe：

1. `sandbox="allow-scripts"`，**不给 `allow-same-origin`** → 文档落在不透明源（origin=`null`）。
2. 据此**天然**拿不到：父页 DOM、`window.electronAPI`、`localStorage`、`IndexedDB`。
3. CSP 二次收口：`default-src 'none'` 起步；`connect-src 'none'`（脚本不能发网络请求，
   外泄面归零）；`frame-src 'none'`（不能再套子帧绕行）。`script-src` 含 `'unsafe-eval'`——
   脚本本就靠它执行，且只在孤岛内生效。
4. 父页只认 `event.origin === 'null'` 且 `event.source` 是本页 iframe 的消息，拒绝任何同源冒充。
5. 「发送一句话」收敛为唯一对外通道：`onclick="input('…')"`，由沙箱改写为 `data-vcp-input`
   属性、统一委托上报，父页单一入口处审。

已用真实浏览器实测（`scripts/sandbox-live-test.mjs`）：脚本确实执行、且摸不到父页 /
localStorage / `electronAPI`，`input` 桥能双向过桥，父页读子页 DOM 抛跨源错误。

## 卸载契约

删掉本目录 = 整体卸载，主功能不受影响：

1. `enable.json` 不存在 → 主进程 `startRawHtml()` 直接返回，动态 import 失败被 catch。
2. `enable: false` → 同样不启动，`/plugins` 面板显示已禁用。
3. 渲染层 `content-extension.ts` 无人注册时 `renderers.length === 0`，`AgentContent` 直接走
   `renderMarkdown`——与扩展点引入前**逐字节一致**。

## 验收

```bash
node scripts/boot-test.mjs          # 引擎注册链路（宿主 + 注入契约 + 引擎）
node scripts/m2m3-test.mjs          # M2 前置条件 + M3 风格库（23 项断言）
node scripts/sandbox-live-test.mjs  # 真实浏览器：脚本隔离实测（需 Edge/Chrome）
```

## 已知边界

- 沙箱内脚本**不能**跨域请求（`connect-src 'none'`）；需要联网的程序页做不了，这是有意的。
- 沙箱 iframe 高度由子页上报（ResizeObserver + 定时兜底），无 CSS `auto` 高度。
- 风格库是**只读**的：AI 不会自动写入新风格（上游的「进化的美学库」未移植）。

