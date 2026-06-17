# seek-agent — 项目总览

seek-agent 是一个**AI 编程助手运行时**，核心是一个由 system prompt + 工具系统驱动的 AI Agent，同时配套了 TUI / Electron / VS Code Extension 三种交互界面。整个项目围绕"让 AI 在本地工作区安全、高效地协助编程"这一目标设计。

---

## 一句话概括

Monorepo（pnpm workspace），TypeScript 全栈，核心是一个 `CLIAAgent` 类 + 可热插拔的 inner_skills 工具系统 + 可选的桌面/IDE 界面。

---

## 项目结构

```
seek-agent/
├── src/                          # 核心代码
│   ├── index.ts                  # TUI 模式入口（TerminalUI + CLIAAgent）
│   ├── electron-entry.ts         # Electron 模式入口（ElectronUIBridge + CLIAAgent）
│   ├── agent.ts                  # CLIAAgent — 核心 Agent 类
│   ├── ui.ts                     # TerminalUI — 终端渲染层（大文件，有 5w+ 字符）
│   ├── electron-bridge.ts        # ElectronUIBridge — stdio JSON 协议桥接
│   ├── message_managing.ts       # MessageHook — 上下文去重/管理
│   ├── memory_agent.ts           # composeHooks — hook 组合器
│   ├── model-provider.ts         # AI 模型单例（自动选择 provider）
│   ├── tokenizer-service.ts      # Python tokenizer 进程通信
│   ├── workdir.ts                # 工作区路径解析（安全沙箱）
│   ├── command/                  # 指令系统（/exit, /save, /load 等）
│   ├── prompts/                  # System prompt 分层体系
│   │   ├── MAIN.md               # 主 prompt — 个性/原则/输出格式
│   │   ├── WORKFLOW.md           # 工作流指南 — todo/patch/memory 规范
│   │   ├── platform/             # 平台特定 prompt（WIN/MAC/LINUX）
│   │   └── addon/                # 领域 addon prompt（前端/MC 模组等）
│   └── tools/                    # 工具系统
│       ├── index.ts              # 工具注册中心 + inner_skills 动态加载器
│       ├── read-file.ts          # 文件读取工具
│       ├── file-manipulation.ts  # Patch 暂存系统（add/del/modify/ensure）
│       ├── execute-command.ts    # 命令执行
│       ├── search-files.ts       # 文件搜索
│       ├── ref-desk.ts           # 参考桌面（desk_add/list/remove/clear）
│       ├── desk-edit.ts          # 光标编辑模式（line_cursor/paste/save）
│       ├── todo.ts               # Todo 系统
│       ├── memory.ts             # 上下文管理（memory_focus/shorten）
│       ├── tool-cache.ts         # 工具缓存（参数+时间邻近度）
│       ├── panel-registry.ts     # 面板注册
│       └── inner_skills/         # 可热插拔技能插件（30+）
│
├── electron/                     # Electron 桌面应用
│   ├── main.js                   # 主进程：spawn agent + BrowserWindow
│   ├── preload.cjs               # IPC 桥接
│   └── renderer/                 # Web UI（html/css/js）
│
├── extension/                    # VS Code 扩展
│   └── src/
│       ├── activate.ts           # 扩展入口
│       ├── agentProcess.ts       # agent 进程管理
│       ├── agentClient.ts        # JSON-RPC 客户端
│       ├── chatParticipant.ts    # Chat 参与者（流式渲染）
│       ├── completionProvider.ts # 内联补全
│       └── codeActionProvider.ts # 灯泡菜单
│
├── packages/agent-runtime/       # JSON-RPC 运行时（独立包）
│   └── src/
│       ├── server.ts             # JSON-RPC over stdio 服务端
│       └── llm/                  # LLM 处理（chat + completion）
│
├── tokenizer/                    # Python tokenizer 服务
├── sessions/                     # 自动保存的会话记录
├── docs/                         # 设计报告/PPT
└── reference/                    # 参考资源
```

---

## 核心架构

### Agent 循环 (`src/agent.ts`)

`CLIAAgent` 是核心，其运行循环为：

```
用户输入 → [inputQueue] → processRound()
  ├─ drainInputQueue()          ← 收集本轮所有输入
  ├─ aiInteractionLoop()        ← AI 对话 + 工具调用循环
  │   ├─ streamText()           ← 调用 LLM，流式接收输出
  │   ├─ executeToolCalls()     ← 按序执行工具
  │   │   ├─ toolCache 缓存     ← 相同参数+连续+时间邻近则命中
  │   │   ├─ listen 拦截器      ← 工具执行前后触发子 agent 分析
  │   │   └─ 返回结果 → 继续循环
  │   └─ 纯文本回复 → 结束本轮
  ├─ postRoundHook()            ← 每轮结束回调
  └─ triggerInstructor()        ← 触发 instructor 发散
```

关键设计：
- **输入队列**：AI 处理期间新输入不丢失，排队等下一轮
- **中断回滚**：新输入打断工具调用时，回滚部分执行的 tool results
- **消息 Hook**：发送给模型前可预处理（目前做读取类工具去重）
- **自动保存**：每轮结束自动存 session 到 `sessions/`

### 工具系统 (`src/tools/index.ts`)

双层结构：

1. **Core Tools** — 硬编码的基础工具（文件读写、搜索、patch、todo、memory 等）
2. **Inner Skills** — `inner_skills/` 目录下每个子目录是一个独立插件

每个 inner_skill 包含：
- `enable.json` — 启用状态 + 描述
- `index.ts` — 工具导出
- `translation.ts` — 工具调用的人类可读标签
- `panel.ts` — （可选）自定义面板
- `SYSTEM_INJECTION.md` — （可选）注入到 system prompt 的内容

启用/禁用只需修改 `enable.json`，热加载调用 `reload_skills` 工具。

### Prompt 分层体系

```
MAIN.md                          ← 核心人格/原则
  ├── platform/WINDOWS.md        ← 平台特定（条件加载）
  ├── WORKFLOW.md                ← 工作流规范
  ├── addon/*.md                 ← 领域知识（手动启用）
  ├── [已启用的 skill 列表]       ← 自动生成
  └── [各 skill 的 SYSTEM_INJECTION.md] ← 自动注入
```

加载逻辑在 `agent.ts` 的 `loadDefaultPrompts()` 方法中。

### 四种部署方式

| 模式 | 入口 | 界面 | 通信协议 |
|------|------|------|---------|
| **TUI** | `src/index.ts` | 终端 | 直接调用 |
| **Electron** | `electron/main.js` → `src/electron-entry.ts` | Web UI | stdio JSON |
| **VS Code 扩展** | `extension/src/activate.ts` → `packages/agent-runtime/` | VS Code 原生 | JSON-RPC over stdio |
| **独立运行时** | `packages/agent-runtime/` | 无界面 | JSON-RPC over stdio |

### 子 Agent 系统

四种模式：

| 模式 | 场景 | 说明 |
|------|------|------|
| **clone** | 需要完整上下文 | 继承主模型全部对话历史 |
| **mission** | 专业分工 | 独立 system prompt + 工具集 |
| **listen** | 旁路监控 | call（执行前检查）/ result（执行后审查） |
| **instructor** | 发散补充 | 每轮工作后提建议（自动重置计数） |

---

## 数据流

```
用户输入
    ↓
指令系统（/command）→ 匹配指令则执行，不匹配则↓
    ↓
CLIAAgent.run()
    ├─ 排空子 agent pending 提交
    ├─ messageHook 预处理消息
    ├─ streamText → LLM 回复（流式渲染到 UI）
    ├─ 工具调用 → 执行 → 结果渲染 → 继续对话
    └─ 纯文本回复 → 结束本轮 → postRoundHook → 自动保存 session
```

---

## 关键设计决策

- **Patch 暂存区**：所有文件修改进入暂存区（add/del/modify），统一 `ensure_patch` 后写入，避免行号漂移
- **工具缓存**：同参数 + 连续调用 + 时间邻近（600ms）才命中，避免重复读取，同时防止过时结果
- **工作区沙箱**：所有路径解析受 `workdir.ts` 限制，不允许访问工作区外的路径
- **单例模型**：`model-provider.ts` 缓存模型实例，子 agent 复用同一 provider 以命中 prompt 缓存
- **自动会话保存**：每轮结束自动写 `sessions/session-{timestamp}.json`，可通过 `/save` `/load` 管理

---

## 开发指引

### 环境要求

- Node.js 20+
- pnpm 10+
- Python 3（tokenizer，可选）
- LibreOffice（xlsx 公式重算，可选）

### 启动

```bash
pnpm dev             # TUI 模式
pnpm electron        # Electron 桌面模式
pnpm build:agent     # 构建 agent-runtime（给 VS Code 扩展用）
pnpm build:ext       # 构建 VS Code 扩展
```

### 创建新 Inner Skill

```bash
# 使用 skill-creator 工具（在对话中调用）：
create_skill(
  skillName: "my_skill",
  description: "技能描述",
  tools: [{ name: "...", description: "...", params: [...] }]
)
```

生成骨架后，补充 `enable.json`、`index.ts` 中的实现、`translation.ts` 中的工具标签，可选加 `SYSTEM_INJECTION.md`。然后对话中调用 `reload_skills` 热加载。

### 添加新指令

在 `src/command/commands/` 下新建文件，实现 `Command` 接口（`match` + `execute`），然后在 `src/command/index.ts` 的 `createCommandRegistry()` 中注册。

### 添加 addon prompt

在 `src/prompts/addon/` 下新建 `.md` 文件，然后在 agent 的 prompt 加载逻辑中手动引入（当前未做自动发现，需修改 `loadDefaultPrompts()`）。

---

## 技能清单（已启用的 inner_skills）

当前 30+ 个技能覆盖：
- **代码分析**：code-reader, code-edit-detector
- **GitHub**：gh-explorer, github-commit-helper, github-pr-description
- **UI/UX**：github-ui-ux-pro-max（含 6 个子模块）, frontend-helper, icon-lib, html-toolkit
- **Office**：github-docx-official, github-pdf-official, github-pptx-official, github-xlsx-official
- **测试/调试**：github-testing-patterns, github-debugging-strategies
- **API 设计**：github-api-design
- **文档/图片**：pdf-reader, image-identifier, image-crawler
- **Web**：web-accessor, web-crawler
- **系统**：sub-agent, skill-creator, skill-manager, ref-reader, todo-manager, virtual-explorer
- **Minecraft 模组**：mc-mod-helper
- **编辑器**：desk-editor

每个技能有 `enable.json` 控制启停，`SYSTEM_INJECTION.md` 向主 prompt 注入说明。
