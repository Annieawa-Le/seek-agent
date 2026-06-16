# Seek Agent Electron WebUI — 测试指南 & 调试记录

---

## 一、你应该怎么测试

### 1. 分层测试策略

不要直接 `electron .` 看全部通不通。**先测后端，再测 IPC，最后测前端。**

```
后端的后端:  agent 进程 stdin/stdout 是否正常  →  node _test_agent.mjs
后端:         Electron 主进程能否启动 agent     →  node _test_electron.mjs
IPC:          preload → renderer 事件是否送达   →  DevTools console.log
前端:         renderer.js 有没有语法错误        →  node --check renderer.js
全链路:       发一条消息看能不能走通             →  electron .
```

### 2. 每步该怎么做

#### 步骤 A：测 agent 进程本身（隔离 Electron）

创建一个独立脚本，用 `spawn` 启动 agent，发消息，检查响应。

```js
// _test_agent.mjs
const p = spawn('node.exe', ['--import', 'tsx/esm', entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: false,           // ← 关键！Windows 下必须 false
});
```

**检查表：**
- [ ] stdout 是否收到 `{"type":"init-done"}`
- [ ] stdin 写入 `{"type":"input","content":"hi","id":"1"}` 后，stdout 是否有 `message`/`append` 响应
- [ ] 进程是否保持存活（`p.exitCode === null`）

**踩坑记录：** 如果 `shell: true`，Windows 上批处理文件（`npx.cmd`）的 stdin pipe 不会传到 node 进程，agent 因 stdin EOF 立即退出。

#### 步骤 B：测 Electron 主进程的 spawn

用 `import { app } from 'electron'` 写一个极简 main.js，只测 spawn 不创窗口。

**检查表：**
- [ ] 在 Electron 进程里 `spawn('node.exe', ...)` 是否工作
- [ ] stdout 是否收到 `init-done`
- [ ] Electron 的 `process.env.PATH` 里有没有 node.exe 的路径

**踩坑记录：** 直接用 `npx.cmd` 时，electron 进程里也跑不起来，必须用 node.exe 直连。

#### 步骤 C：检查 renderer.js 语法

```bash
node --check electron/renderer/renderer.js
```

如果报语法错误，`renderer.js` 整个不会执行，而且**浏览器不会告诉你**。

**踩坑记录：** 多余的 `}` 让整个文件在加载期就崩了。状态栏空白、ctx 红色、发不了消息，但 DevTools Console 没有红色错误——因为脚本根本没跑到注册事件监听器的代码。

#### 步骤 D：检查 preload IPC 通不通

在 renderer.js 开头加一行：

```js
console.log('[renderer] electronAPI:', !!window.electronAPI);
```

打开 DevTools Console，看 `electronAPI` 是不是 `true`。

#### 步骤 E：全链路测试

```bash
taskkill /f /im electron.exe 2>nul
node_modules\.bin\electron .
```

**检查表：**
- [ ] 控制台输出 `[main] Agent ready`
- [ ] 状态栏显示"就绪"，绿点
- [ ] 输入消息按 Enter，发送按钮变灰
- [ ] Agent 回复出现在消息列表
- [ ] 上下文数字更新

### 3. 测试中容易踩的坑

| 坑 | 现象 | 怎么避免 |
|----|------|----------|
| Electron 进程残留 | 改了代码重启没效果 | 每次 `taskkill /f /im electron.exe` |
| `shell: true` 的 stdin 问题 | agent 启动即退出 | 永远用 `spawn('node.exe', [...args], { shell: false })` |
| 前端 JS 语法错误静默 | 界面全白但无报错 | 先 `node --check renderer.js` |
| DevTools 没开 | 看不到 console 日志 | main.js 里 `process.env.NODE_ENV === 'development'` 时自动开，或手动 Ctrl+Shift+I |
| preload.js 用错模块格式 | contextBridge 没暴露 API | Ensure preload is `.cjs` if package.json has `"type": "module"` |

---

## 二、调试工具链

### 推荐的最小测试集

在项目根目录放两个测试脚本，改完关键文件后跑一遍：

**`_test_agent.mjs`** — 验证 agent 进程 spawn 和通信

```js
import { spawn } from 'child_process';
// spawn + stdin 写消息 → 检查 stdout 响应
```

**`_test_electron.mjs`** — 验证 Electron 里能启动 agent

```js
import { app } from 'electron';
import { spawn } from 'child_process';
// 只 spawn 不创窗口，验证进程存活
```

### 快速验证命令

```bash
# 1. JS 语法检查
node --check electron/renderer/renderer.js
node --check electron/main.js

# 2. 杀残留进程
taskkill /f /im electron.exe 2>nul

# 3. 启动
node_modules\.bin\electron .
```

### 打开 DevTools 的几种方式

- main.js 里配：`NODE_ENV=development` 时自动 `mainWindow.webContents.openDevTools()`
- 运行时按 `Ctrl+Shift+I`（Windows）
- 在 `BrowserWindow` 构造参数里加：`webPreferences: { devTools: true }`

---

## 三、本次调试时间线（参考）

| 步骤 | 做了什么 | 花了多久 | 备注 |
|------|---------|---------|------|
| 1 | 发现 agent 启动即退出 | ~10min | 怀疑 spawn 方式 |
| 2 | 测 `npx.cmd` + `shell:true` vs 直连 | ~15min | 确认是批处理问题 |
| 3 | 改 main.js 用 `node.exe` 直连 | ~5min | 但看不懂为啥启动 Electron 还是坏 |
| 4 | 绕圈——反复改 main.js 无效 | ~15min | 没杀旧进程 |
| 5 | 发现 Electron 进程残留 | ~10min | 杀干净后好了 |
| 6 | 发现 renderer.js 语法错误 | ~5min | 多一个 `}` 导致整个 JS 不执行 |
| 7 | 写文档 | 现在 | — |

**如果可以重来：** 第一步就该 `node --check renderer.js`，省掉一半时间。

---

## 四、协议参考

### stdout（子进程 → 主进程）

```typescript
type ChildToParent =
  | { type: 'init-done' }
  | { type: 'message'; role: 'user'|'agent'|'tool'|'system'; content: string; toolMeta?: {...} }
  | { type: 'append'; content: string }
  | { type: 'state'; processing: boolean }
  | { type: 'context'; chars: number; tokens: number }
  | { type: 'thinking'; active: boolean }
  // ... 等等
```

### stdin（主进程 → 子进程）

```typescript
type ParentToChild =
  | { type: 'input'; content: string; id: string }
  | { type: 'command'; cmd: string; id: string }
  | { type: 'abort' }
  | { type: 'exit' }
```

---

## 五、配置文件速查

### 入口链

```
electron .
  → package.json main = "electron/main.js"
    → spawn('node.exe', ['--import', 'tsx/esm', 'src/electron-entry.ts'])
      → ElectronUIBridge.startListening() ← process.stdin
      → agent.run(userInput) → bridge.send() → process.stdout
        → main.js handleAgentMessage()
          → mainWindow.webContents.send('agent:message', msg)
            → renderer.js handleAgentMessage(msg)
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `electron/main.js` | Electron 主进程，spawn agent，IPC 中转 |
| `electron/preload.cjs` | contextBridge 暴露 electronAPI |
| `electron/renderer/index.html` | 页面结构 |
| `electron/renderer/style.css` | 样式 |
| `electron/renderer/renderer.js` | 前端逻辑，消息渲染，事件绑定 |
| `src/electron-entry.ts` | Agent 入口（子进程） |
| `src/electron-bridge.ts` | ElectronUIBridge，stdin/stdout JSON 协议 |
