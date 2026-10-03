## 主题皮肤（dsh-theme）

为用户安装 DSH（DeepSeek Harness）第三方主题皮肤，让界面换装。

工作机制：皮肤包（`skin.json` + `skin.css` + 可选 `skin.js` + `assets/`）里的选择器全部依赖
DSH 的 DOM 契约，插件的**转义层**负责把 seek-agent 的 DOM 翻译成 DSH 结构（影子类名 +
`data-slot` / `data-pane` / `data-*` 钩子 + `--dsw-*` 令牌表），**加载器**再补上转义层补不了的
一处（DSH 0.2 皮肤把应用根写作 `[id=root]`，宿主的根是 `#app`，在 CSS 文本层等价替换）。

- 想了解装了哪些皮肤：调用 `theme_list`
- 排查皮肤没生效：调用 `theme_status`（确认 enable 与激活项）
- 切换皮肤：修改 `enable.json` 的 `theme` 字段后**重启 seek-agent**（宿主在窗口就绪时装载）；
  运行中切换走设置 →「主题」栏目（热切换）
- 安装新皮肤：把皮肤包放进 `themes/<id>/`（至少要有 `skin.json` 与 `skin.css`）

皮肤包格式（`skin.json` 关键字段）：

```json
{
  "id": "my-skin",
  "name": "皮肤显示名",
  "css": "skin.css",
  "script": "skin.js",
  "assets": { "background": "assets/bg.webp" },
  "palette": { "background": "#…", "panel": "#…", "text": "#…", "accent": "#…" },
  "colorScheme": "dark",
  "scope": { "owner": "my-skin", "bodyAttribute": "data-my-skin", "title": "…" }
}
```

- `css`：皮肤样式，选择器须使用 DSH 契约（见下方转义层提供的锚点）
- `script`：可选，DSH 客户端插件形态的 `apply(ctx)`（`ctx.effect(fn, name)` 注册副作用）
- `palette`：设置面板的色块预览（背景 / 面板 / 文字 / 强调色）
- `colorScheme`：可选，`"dark"` / `"light"`。**只有一套固定配色**时才声明——加载期间应用会锁定该
  亮暗（宿主自带另一套亮暗覆写，单色皮肤压不住它们，混着来会满屏亮色补丁），卸载皮肤后用户
  自己的偏好自动恢复。**按 `body[data-ds-dark-theme]` 分支的双配色皮肤请留空**，别锁。
- 布局注意：宿主右侧栏是活的、会占内容列宽，皮肤里推列宽不要用 `100vw`（它不扣右栏），
  用 `max-width` 交给容器算
- `scope.bodyAttribute`：皮肤作用域属性，CSS 里用 `body[data-xxx]` 圈定范围

### 两代 DSH DOM 契约

| 契约世代 | 根节点 | 三列 | 典型皮肤 |
|---|---|---|---|
| DSH 0.1.x | `[class*='_frame']` / `[data-slot='root']` | `[class*='_sidebarCol']` 等 | roxy-celestial-library 等第三方皮肤 |
| DSH 0.2.x | `[id=root]`（加载器改写为 `#app`） | `[data-pane='sidebar'\|'conversation'\|'details']` | dsh-web-ui / EAC 内置系列（10 款，已随包） |

转义层提供的锚点对照：

| DSH 契约 | seek-agent 落点 |
|---|---|
| `[class*='_frame']` / `[data-slot='root']` / `[id=root]` | `#app` |
| `[class*='_sidebarCol']` / `[data-slot='sidebar']` / `[data-pane='sidebar']` | `#left-sidebar` |
| `[class*='_centerCol']` / `[data-slot='conversation']` / `[data-pane='conversation']` | `#main-content` |
| `[class*='_detailsCol']` / `[data-slot='details']` / `[data-pane='details']` | `#info-panel` |
| `[data-conversation-scroll]` | `#message-area` |
| `[data-slot='conversation.view']` | `#message-list` |
| `[data-composer-card]` | `.input-bar-body` |
| `[class*='_primary']`（发送钮） | `.send-btn` |
| `--dsw-alias-*` / `--dsw-static-*` | 由令牌层补齐（含 `--dsw-color-*` 兼容别名） |

### 皮肤脚本的伪 ctx

DSH 皮肤脚本签名是 `apply(ctx)`。加载器给的伪 ctx 提供：

- `ctx.effect(fn, name)` —— 注册副作用，`fn` 返回清理函数，卸载皮肤时逐个调用
- `ctx.get(name)` —— **恒定返回 `undefined`**。皮肤用它探测宿主服务（`workspaces` / `connection` 等），
  seek-agent 没有这些服务；皮肤一侧普遍写成 `if (x === void 0) return`，自然退化成占位文案

### 导入 DSH 上游皮肤包

上游皮肤包是 DSH 的 `window.__ModuleLoader__` bundle（`lib/client.js` 里一段 CSS 字符串 +
一段纯 DOM 的 `apply`）。用随包的导入器机械转换，**皮肤脚本一行不改、CSS 一字不动**：

```bash
node src/tools/inner_skills/dsh-theme/tools/import-dsh-skins.mjs <源目录> [皮肤 id...] [--verify]
# <源目录> 下每个子目录应含 skin.json + lib/client.js
```

`themes/` 下现有的 10 款（blue-fantasy / dragon-heir / maid-atelier / miku / minecraft / qq98 /
ths / trading / whale-song / xp）即由 EAC 主仓内置的 dsh-web-ui 系列一次性导入，来源与许可见各包
`skin.json` 的 `source` / `license` / `upstream` 字段。

