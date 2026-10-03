# seek-agent — 项目总览

> 本文件是项目的**总览**，也是 agent 的工作记忆。它必须跟着仓库一起走——
> 新模块、新机制、新回归一旦落地，就同步进这里，别让它说谎。

seek-agent 是一个**AI 编程助手运行时**，核心是一个由 system prompt + 工具系统驱动的 AI Agent，配套 TUI / Electron 两种交互界面（VS Code 扩展已搁置）。整个项目围绕"让 AI 在本地工作区安全、高效地协助编程"这一目标设计。

---

## 一句话概括

Monorepo（pnpm workspace），TypeScript 全栈，核心是一个 `CLIAAgent` 类 + 可热插拔的 inner_skills 工具系统 + 可选的桌面/IDE 界面 + MCP 服务集成。

---

## 项目结构

```
seek-agent/
├── src/                          # 核心代码
│   ├── index.ts                  # TUI 模式入口（TerminalUI + CLIAAgent）
│   ├── electron-entry.ts         # Electron 模式入口（ElectronUIBridge + CLIAAgent）
│   ├── agent.ts                  # CLIAAgent — 核心 Agent 类
│   ├── ui.ts                     # TerminalUI 转发薄壳（实现见 src/ui-ink/）
│   ├── ui-ink/                   # TUI 终端渲染层（Ink + React 组件化）
│   ├── electron-bridge.ts        # ElectronUIBridge — stdio JSON 协议桥接
│   ├── message_managing.ts       # MessageHook — 上下文去重/管理
│   ├── memory_agent.ts           # composeHooks — hook 组合器
│   ├── context-compactor.ts      # 记忆消退 — 双阈值预算压缩 + Worklog 归档
│   ├── register-round-hooks.ts   # 每轮后台任务（做梦沉淀 + 会话标题刷新）
│   ├── illusion_agent.ts         # 幻觉验证 agent（可选实验特性）
│   ├── model-provider.ts         # AI 模型单例（自动选择 provider）
│   ├── tokenizer-service.ts      # Python tokenizer 进程通信
│   ├── workdir.ts                # 工作区路径解析（安全沙箱）
│   ├── mcp/                      # MCP（Model Context Protocol）集成
│   │   ├── config.ts             # MCP 服务配置
│   │   ├── server-manager.ts     # MCP server 生命周期管理
│   │   └── index.ts              # MCP 工具接入
│   ├── modes/                    # Agent 模式系统
│   │   ├── types.ts              # AgentMode 类型（promptAddon / mainReplacement）
│   │   ├── registry.ts           # 模式注册表
│   │   ├── preprocess.ts         # 模式预处理 hook
│   │   ├── panel.ts              # 模式状态面板 + Manager 仪表盘
│   │   ├── chat-thread.ts        # Manager↔下属 协作对话 thread
│   │   ├── mode-preset-store.ts  # 模式预设持久化（ModeSelector 用）
│   │   └── index.ts              # 内置模式注册（kb / manager / worker）
│   ├── command/                  # 指令系统（/exit, /save, /load 等）
│   ├── prompts/                  # System prompt 分层体系
│   │   ├── MAIN.md               # 主 prompt — 个性/原则/输出格式
│   │   ├── INSTRUCTOR.md         # Instructor 子 agent 提示词（可自定义）
│   │   ├── WORKFLOW.md           # 工作流指南 — todo/patch/memory 规范
│   │   ├── workers/              # 预制员工库（7 位：小码/老审/阿修/测测/小研/文文/小鱼）
│   │   ├── platform/             # 平台特定 prompt（WIN/MAC/LINUX）
│   │   └── addon/                # 领域 addon prompt（KB/MANAGER/WORKER 等）
│   └── tools/                    # 工具系统
│       ├── index.ts              # 工具注册中心 + inner_skills 动态加载器
│       ├── read-file.ts          # 文件读取工具
│       ├── file-manipulation.ts  # Patch 系统（add/del/modify/ensure + 定位函数）
│       ├── patch-batch.ts        # 并行 patch 静默暂存（基准快照 + 从后往前合并应用）
│       ├── patch-undo.ts         # Patch 撤销（diff 持久化到 .seek-agent/history/）
│       ├── syntax-validator.ts   # 语法检查 + 修改后模拟状态预览
│       ├── execute-command.ts    # 命令执行（UTF-8 智能解码）
│       ├── search-files.ts       # 文件搜索
│       ├── replace-str.ts        # 字符串字面量替换
│       ├── action-memory.ts      # Action 记忆（行为准则提炼/巩固）
│       ├── mission.ts            # 任务段归档（mission-start/accomplish/cancel）
│       ├── command-log.ts        # 取回 execute_command 的完整输出
│       ├── cmd-log-store.ts      # latest-cmd.log 落盘与读取
│       ├── task-runner.ts        # 后台任务（task_execute/switch/kill）
│       ├── ref-desk.ts           # 参考桌面（desk_add/list/remove/clear）
│       ├── desk-edit.ts          # 光标编辑模式（line_cursor/paste/save）
│       ├── todo.ts               # Todo 系统
│       ├── memory.ts             # 上下文管理（memory_focus/shorten）
│       ├── worklog-store.ts      # Worklog 归档（按 sessionId 分区）
│       ├── worklog-tools.ts      # worklog_recall / work_recall 召回
│       ├── tool-cache.ts         # 工具缓存（参数+时间邻近度）
│       ├── panel-registry.ts     # 面板注册
│       └── inner_skills/         # 可热插拔技能插件（41 个）
│
├── electron/                     # Electron 桌面应用
│   ├── main.js                   # 主进程：spawn agent + BrowserWindow + 会话管理
│   ├── preload.cjs               # IPC 桥接
│   ├── patch-history.js          # .seek-agent/history/*.diff 的读取约定
│   ├── patch-revert.js           # 按 unified diff 逆向还原文件内容
│   └── renderer/                 # Web UI（React + Vite + TypeScript）
│       ├── components/           # FileEditor / ReviewDock / ReviewList / SelectionToolbar 等
│       ├── fonts/                # LXGW WenKai 霞鹜文楷（含 Mono 字族）
│       └── utils/                # patch-merge / review-watermark / selection-context 等
│
├── benchmarks/                   # 本地基准（fixtures 三场景 + run-benchmark / headless-ui）
│
├── extension/                    # VS Code 扩展（已搁置，目录移除；历史代码见 git）
│
├── packages/agent-runtime/       # JSON-RPC 运行时（独立包）
│   └── src/
│       ├── server.ts             # JSON-RPC over stdio 服务端
│       └── llm/                  # LLM 处理（chat + completion）
│
├── tokenizer/                    # Python tokenizer 服务
├── sessions/                     # 自动保存的会话记录（含 worklogs/ 归档分区）
├── docs/                         # 设计报告/PPT
└── reference/                    # 参考资源
```

---

## 核心架构

### Agent 循环 (`src/agent.ts`)

`CLIAAgent` 是核心，其运行循环为：

```
用户输入 → [inputQueue] → processRound()
  ├─ drainInputQueue()          ← 收集本轮所有输入（含 instructor 异步建议）
  ├─ applyPendingCompaction()   ← 安全点应用记忆消退（Worklog 归档）
  ├─ aiInteractionLoop()        ← AI 对话 + 工具调用循环
  │   ├─ streamText()           ← 调用 LLM，流式接收输出（传剥离 execute 的只读工具集）
  │   ├─ executeToolCalls()     ← 按序执行工具
  │   │   ├─ beginPatchBatches  ← 同批 ≥2 patch 同文件 → 静默暂存批次
  │   │   ├─ toolCache 缓存     ← 相同参数+连续+时间邻近则命中
  │   │   ├─ listen 拦截器      ← 工具执行前后触发子 agent 分析
  │   │   ├─ flushPatchBatches  ← 批次从后往前合并应用，一次写盘
  │   │   └─ 返回结果 → 继续循环
  │   └─ 纯文本回复 → 结束本轮
  ├─ postRoundHook()            ← 每轮结束回调
  └─ triggerInstructorAfterRound() ← 异步触发 instructor 发散（不阻塞主模型）
```

关键设计：
- **输入队列**：AI 处理期间新输入不丢失，排队等下一轮；instructor 建议以消息形式入队驱动新一轮
- **中断回滚**：新输入打断工具调用时，回滚部分执行的 tool results；批次 discardAll
- **消息 Hook**：发送给模型前可预处理（读取类工具去重、模式预处理、编辑锁定）
- **自动保存**：每轮结束自动存 session 到 `sessions/`
- **Instructor 异步信号**：每轮后 fire-and-forget 启动 instructor 子 agent，后台完成后把建议 push 回输入队列（鲸鱼气泡 UI），不阻塞主模型

### 工具系统 (`src/tools/index.ts`)

双层结构：

1. **Core Tools** — 硬编码的基础工具（文件读写、搜索、patch、todo、memory、worklog 等）
2. **Inner Skills** — `inner_skills/` 目录下每个子目录是一个独立插件（32 个）

每个 inner_skill 包含：
- `enable.json` — 启用状态 + 描述
- `index.ts` — 工具导出
- `translation.ts` — 工具调用的人类可读标签
- `panel.ts` — （可选）自定义面板
- `SYSTEM_INJECTION.md` — （可选）注入到 system prompt 的内容

启用/禁用只需修改 `enable.json`，热加载调用 `reload_skills` 工具。

### Patch 系统（`file-manipulation.ts` + `patch-batch.ts`）

- 普通模式：add/del/modify 定位后直接写盘，diff 持久化可撤销
- **批次模式**：同一条 assistant 消息里多个 patch 作用于同一文件时（≥2 个），进入静默暂存——基于同一基准快照定位，flush 时从后往前按基准行号合并应用，一次写盘 + 一条 `batch` undo 记录；语法检查失败或行号越界返回 `ok:false` 且文件保持原状
- 三个定位函数（`locateAddInsertion`/`locateDelRanges`/`locateModifyRange`）普通与批次模式共用
- 语法失败时展示「修改后模拟状态」块（错误行 ±4 行窗口 + 行号 + 标记）

### 内嵌编辑器与代码审查（`electron/patch-history.js` + `electron/patch-revert.js` + renderer）

主区新增**文件编辑器标签页**（`FileEditor.tsx`）：右侧文件面板双击，或把文件拖进标签栏即可打开。围绕它长出一整套「改—看—退」的闭环：

- **内联差异**：`InlineDiffView.tsx` 把每笔改动渲染成 unified diff，不用切出去比对
- **审查面板**：`ReviewDock.tsx` + `ReviewList.tsx` 列改动，`useFilePatches.ts` 管状态，`review-watermark.ts` 标进度
- **选中即问**：`SelectionToolbar.tsx` + `selection-context.ts`，选中一段代码就能直接向 agent 提问
- **一键回退**：`patch-revert.js` 按 unified diff **逆向还原**文件内容

回退逻辑值得单说——`.diff` 里只存了「上下文 + 删除行 + 新增行」，没存改动前的全文，所以还原靠锚点反推：

```
改动前：  before  removed  after
改动后：  before  added    after        ← 拿 after 当锚点，把 added 换回 removed
```

定位用**三级锚点**逐级降级（`before+added+after` → `before+added` → 仅 `added`），命中后再按「本次实际用上了哪几段」逐项复核。若文件里有多处相同内容、无歧义信息不足，**宁可返回 `notFound` 提示手动处理，也不猜一个位置乱写**。

diff 存盘在 `.seek-agent/history/*.diff`（元信息 JSON 头 + 60 个 `─` 分隔线 + 正文），`patch-history.js` 与测试脚本共用同一套解析约定。


### Prompt 分层体系

```
MAIN.md / 模式 mainReplacement       ← 核心人格/角色（manager/worker 替换 MAIN）
  ├── INSTRUCTOR.md                 ← instructor 子 agent 提示词（可自定义）
  ├── platform/WINDOWS.md           ← 平台特定（条件加载）
  ├── WORKFLOW.md                   ← 工作流规范
  ├── addon/*.md                    ← 领域 addon（KB/MANAGER/WORKER 等，手动启用）
  ├── [已启用的 skill 列表]          ← 自动生成
  └── [各 skill 的 SYSTEM_INJECTION.md] ← 自动注入
```

加载逻辑在 `agent.ts` 的 `loadDefaultPrompts()` 方法中。模式有两种形态：`promptAddon`（附加型）与 `mainReplacement`（角色型，替换 MAIN.md）。

### 记忆系统

双层记忆 + 消退路径：

1. **工作记忆**（短期）：WeightedLRU，30 条容量，按 (最近访问/权重) 自动淘汰
2. **长期记忆**（持久知识）：向量化存储 + 相似度去重，跨会话检索
3. **记忆消退**：`context-compactor.ts` 双阈值预算（触发线 100k tokens / 停止线 75%），副模型把旧轮次压缩为结构化 Worklog（标题/用户意图/关键决策/文件改动/待办/取回指引），归档到 `sessions/worklogs/{sessionId}.json`；头部旧 Worklog 再降级为归档行，可通过 `worklog_recall`/`work_recall` 召回

### 任务段归档与命令日志

**mission（任务段归档）**（`src/tools/mission.ts`）——把一段独立工作的**过程**整段移出上下文：

| 工具 | 作用 |
|------|------|
| `mission-start(name)` | 标记任务段起点（记录 `mission-start` 调用在消息列表中的位置） |
| `mission-accomplish(summary)` | 收尾：把起点到本次调用之间的上下文整段裁剪，以 Worklog 落盘（**会话中不留条目**） |
| `mission-cancel()` | 结束标记但不裁剪（任务中止、或这段过程仍需留在上下文时用） |

与 `memory_focus` 的区别：后者保留一条梗概在会话里，mission 是**彻底移出**，仅落盘，靠 `worklog_recall` / `work_recall` 取回。裁剪边界落在整条 assistant 消息上，不会撕裂 tool-call / tool-result 配对；若起点消息已被记忆消退压缩掉，则本次不裁剪并给出提示。一次只允许一个进行中的任务段。

**command_log**（`src/tools/command-log.ts` + `cmd-log-store.ts`）——`execute_command` 返回给模型的文本截断到 10000 字符，完整输出落盘到会话的 `latest-cmd.log`（覆盖式，只留最近一次），用 `command_log` 取回（默认上限 100000 字符）。看到截断提示时调它，不要反复重跑同一条命令。


### 四种部署方式

| 模式 | 入口 | 界面 | 通信协议 |
|------|------|------|---------|
| **TUI** | `src/index.ts` | 终端 | 直接调用 |
| **Electron** | `electron/main.js` → `src/electron-entry.ts` | Web UI | stdio JSON |
| **VS Code 扩展** | 已搁置（目录移除，不再维护） | — | — |
| **独立运行时** | `packages/agent-runtime/` | 无界面 | JSON-RPC over stdio |

### 子 Agent 系统

四种模式：

| 模式 | 场景 | 说明 |
|------|------|------|
| **clone** | 需要完整上下文 | 继承主模型全部对话历史 |
| **mission** | 专业分工 | 独立 system prompt + 工具集（含 worker-library 预制员工） |
| **listen** | 旁路监控 | call（执行前检查）/ result（执行后审查） |
| **instructor** | 发散补充 | 每轮后异步提建议（鲸鱼气泡），自动重置计数 |

子模型支持：工具用途简述注入（工具名：一句话用途 + 所属 skill 的 SYSTEM_INJECTION.md）、提交结果以 `【xxx 提交工作结果】` user 消息注入（兼容上游对 tool_call_id 的精确校验）。

### Agent 模式系统

内置三种模式（`src/modes/` + ModePicker UI）：

| 模式 | 形态 | 定位 |
|------|------|------|
| **kb** | promptAddon | 知识库模式：每次回答前并行检索 工作记忆 + 长期记忆 + kb_query 三层 |
| **manager** | mainReplacement | 管理者：筹划拆解委派给下属（子模型），自己很少干活 |
| **worker** | mainReplacement | 打工人：主导接活，开工前先创建开发引导员（instructor）监督，可摇人帮忙 |

Manager 模式下有协作聊天面板（通讯录 + ChatView），`chat:send <peer>|<content>` 可与下属对话。

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

- **Patch 批次**：同批多个 patch 基于同一基准快照，从后往前合并应用，避免行号漂移
- **工具缓存**：同参数 + 连续调用 + 时间邻近（600ms）才命中，避免重复读取，同时防止过时结果
- **工作区沙箱**：所有路径解析受 `workdir.ts` 限制，不允许访问工作区外的路径
- **单例模型**：`model-provider.ts` 缓存模型实例，子 agent 复用同一 provider 以命中 prompt 缓存
- **自动会话保存**：每轮结束自动写 `sessions/session-{timestamp}.json`，可通过 `/save` `/load` 管理
- **稳定 sessionId**：`/^(new-[a-z0-9]+|[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i` 固定形态，worklog 分区按它落盘
- **工具防重执行**：AI SDK v6 传入剥离 execute 的只读工具集，executeToolCalls 手动执行一次
- **sessionId 会话隔离**：输入框草稿、kb/智能搜索/思考偏好按会话隔离
- **工作区切换全局化**：`workdir:set` 广播所有存活会话，会话列表跟随当前工作区
- **回退宁可失败不乱写**：`patch-revert.js` 三级锚点定位 + 落点复核，无歧义信息不足时返回 `notFound` 而非猜位置
- **mission 与 memory_focus 分工**：mission 把过程整段移出上下文（仅落盘、会话无条目），memory_focus 保留一条梗概
- **mission 裁剪不撕配对**：裁剪边界落在整条 assistant 消息上，tool-call / tool-result 始终保持成对
- **命令输出落盘**：`execute_command` 超 10000 字符即截断，完整结果写 `latest-cmd.log`，靠 `command_log` 取回而不是重跑
- **diff 解析只在行边界下刀**：`.diff` 正文每行都带前缀字符（` ` / `+` / `-`），截断必须切在换行处，`trim()` 会吃掉首行前缀使整条记录失效

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
dev-electron.bat     # Electron WebUI（Windows：构建前端 + 编译 agent 后打开）
pnpm electron        # Electron 桌面模式（需先构建）
pnpm build:agent     # 构建 agent-runtime（独立运行时 / 打包用）
pnpm build:renderer  # 构建渲染层
pnpm build:pack      # 打包 Windows 安装包（electron-builder）
```

### 测试

测试脚本在 `scripts/` 下，用 tsx 直跑（推荐用 ts-debug 技能的 `ts_run_test`，UTF-8 无损）：

```bash
pnpm tsx scripts/test-context-compactor.ts
```

`scripts/` 下现有 60+ 个回归脚本，按主题分组：

- **补丁与编辑**：`test-patch-batch`、`test-add-patch-semantics`、`test-patch-integration`、`test-patch-locator`、`test-patch-history`、`test-patch-merge`、`test-patch-revert`、`test-replace-str`、`test-edit-layer-enhancement`、`test-wrap-persist`
- **审查与选中**：`test-review-ask`、`test-review-watermark`、`test-selection-context`
- **上下文与记忆**：`test-context-compactor`、`test-memory-workspace`、`test-memory-prompt-utils`、`test-action-memory`、`test-mission`、`test-workdir-roots`
- **子模型与模式**：`test-sub-agent`、`test-chat-thread`、`test-mode-system`、`test-mode-integration`、`test-mode-kb`、`test-worker-library`、`test-instructor-flow`
- **运行时与工具链**：`test-exec-decode`、`test-exec-timeout`、`test-command-log`、`test-task-runner`、`test-upstream-retry`、`test-orphan-tool-repair`、`test-kb-workspace`

常用规模参考：`test-patch-batch`（22）、`test-add-patch-semantics`（8）、`test-patch-integration`（8）、`test-sub-agent`（17）、`test-chat-thread`（13）、`test-mode-system`（25）、`test-mode-integration`（15）、`test-worker-library`（113）、`test-instructor-flow`（25）、`test-context-compactor`（36）、`test-exec-decode`（7）、`test-kb-workspace`（7）

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

### 添加新 Agent 模式

1. 在 `src/modes/registry.ts` 注册模式（`promptAddon` 或 `mainReplacement` 形态）
2. 在 `src/prompts/addon/` 编写模式提示词
3. 可选：在 `src/modes/panel.ts` 注册状态面板
4. 在 `src/modes/index.ts` 的 `registerBuiltinModes()` 中注册

### 添加新预制员工

在 `src/prompts/workers/` 下新建 `.md`，包含 `## 名字`、`## 性格人设`、`----SYSTEM_PROMPT_START/END----` 包裹的 systemPrompt 模板、`----TOOLS_START/END----` 包裹的工具组 JSON，然后在 worker-library 的 `known` 集合登记。









