# Seek Agent — AI 编程助手运行时

> **最前提示！非常重要！**
>
> 这个不算正式发行的项目。
>
> **本 Agent 环境没有沙箱，没有隔离，没有危险代码检测，赋予对工作区完整的操作权限！**
>
> 如果你使用本 Agent，则你应该预料到可能会有数据安全事故的发生！

Seek Agent 是一个**本地运行的 AI 编程助手**：以 `system prompt + 工具系统` 驱动的 AI Agent 为核心，提供 TUI / Electron WebUI / VS Code Extension 三种交互界面。整个项目围绕「让 AI 在本地工作区安全、高效地协助编程」设计。

Monorepo（pnpm workspace），TypeScript 全栈，核心是一个 `CLIAAgent` 类 + 可热插拔的 `inner_skills` 工具系统 + 可选的桌面/IDE 界面 + MCP 服务集成。

---

## 特性

- **完整工具系统**：文件读写、Patch 编辑（带撤销与语法检查）、命令执行、搜索、Todo、双层记忆等 30+ 核心工具
- **32 个可热插拔技能（inner_skills）**：代码分析、GitHub、UI/UX、Office 文档、测试调试、Web 浏览、知识库等，`enable.json` 一键启停，运行中热加载
- **四层 Prompt 体系**：主人格 / 模式角色 / 工作流规范 / 技能注入，可自定义
- **Agent 模式系统**：`kb` 知识库模式、`manager` 管理者模式（拆解委派给子模型下属）、`worker` 打工人模式（开工先请开发引导员监督、可摇人帮忙）
- **子 Agent 系统**：clone / mission / listen / instructor 四种模式，支持预制员工库（小码、老审、阿修、测测、小研、文文、小鱼）
- **双层记忆 + 记忆消退**：短期工作记忆（WeightedLRU）+ 长期持久知识（向量检索），旧轮次自动压缩为 Worklog 归档可召回
- **Patch 批次机制**：同批多个 patch 基于同一基准快照从后往前合并应用，避免行号漂移，语法错误整体回滚
- **MCP 集成**：通过 `@ai-sdk/mcp` 接入 Model Context Protocol 服务
- **Instructor 异步建议**：每轮结束后台启动开发引导员，建议以「鲸鱼气泡」异步推回，不阻塞主模型

---

## 界面形态

| 模式 | 入口 | 界面 | 通信 |
|------|------|------|------|
| **TUI（终端）** | `src/index.ts` | Ink (React) 终端渲染，支持命令面板 / 鼠标 / git 分支显示 | 直接调用 |
| **Electron WebUI** | `electron/main.js` → `src/electron-entry.ts` | 浏览器式标签页、工具调用时间线、状态栏 | stdio JSON |
| **VS Code 扩展** | `extension/src/activate.ts` → `packages/agent-runtime/` | VS Code 原生 Chat / 补全 / 灯泡菜单 | JSON-RPC over stdio |
| **独立运行时** | `packages/agent-runtime/` | 无界面，可被外部程序调用 | JSON-RPC over stdio |

---

## 快速开始

### 环境要求

- Node.js 20+
- pnpm 10+
- Python 3（tokenizer 服务，可选）
- LibreOffice（xlsx 公式重算，可选）

### 安装

```bash
pnpm install
```

### 配置

复制 `.env.example` 为 `.env` 并填写：

```bash
cp .env.example .env
```

最小配置（主模型）：

```env
OPENAI_BASE_URL = https://base.url.here
OPENAI_API_KEY = yourkey
OPENAI_MODEL = deepseek-v4-flash
```

可选配置项见 `.env.example` 注释：轻量模型（`LITE_MODEL_*`）、Tavily 搜索（`TAVILY_API_KEY`）、视觉模型（`IMAGE_*`）、知识库 Embedding（`EMBEDDING_*`）、上下文压缩预算（`MAX_CONTEXT_TOKENS` 等）。

### 启动

```bash
pnpm dev             # TUI 模式（终端）
pnpm dev:webui       # Electron WebUI 开发模式（vite + electron 热更新）
pnpm electron        # Electron 桌面模式
```

---

## TUI 使用指南

命令面板：按 **Ctrl+P** 打开，输入关键词过滤指令/工具，方向键选择、回车执行、Esc 关闭，支持鼠标点击。

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+P` | 打开命令叠加层（command palette） |
| `Ctrl+C` | AI 运行时中断当前轮次，否则退出 |
| `Ctrl+L` | 清屏 |
| `Ctrl+Q` | 强制清理工具调用结果（memory_shorten） |
| `Ctrl+S` | 保存当前会话 |
| `Ctrl+W` | 强制折叠 3 轮前内容（memory_focus） |
| `Ctrl+U` | 清空输入框 |
| `Ctrl+D` | 退出 |
| `Tab` / `Ctrl+I` | 强制中断所有子 agent |

常用指令（输入 `/help` 查看全部）：`/save` `/load` 会话管理、`/mode` 切换 Agent 模式、`/clear` 清屏、`/exit` 退出。

---

## 架构概览

```
用户输入 → 指令系统 → CLIAAgent.run()
    ├─ 排空子 agent 提交 / 应用记忆消退
    ├─ aiInteractionLoop：streamText → 工具调用 → 结果 → 继续对话
    │    └─ executeToolCalls：Patch 批次 / 工具缓存 / listen 拦截器
    └─ postRoundHook → 自动保存 session → Instructor 异步建议
```

核心模块：

- `src/agent.ts` — `CLIAAgent`，Agent 运行循环核心
- `src/ui-ink/` — TUI 终端渲染层（Ink React 组件：标题栏 / 消息区 / 输入栏 / 命令面板 / 状态栏）
- `src/tools/` — 工具系统：核心工具 + inner_skills 动态加载器
- `src/tools/patch-batch.ts` — 并行 patch 静默暂存与合并应用
- `src/context-compactor.ts` — 记忆消退（双阈值预算压缩 + Worklog 归档）
- `src/modes/` — Agent 模式系统（kb / manager / worker）
- `src/mcp/` — MCP 服务集成
- `src/prompts/` — 分层 Prompt 体系（MAIN / INSTRUCTOR / WORKFLOW / workers / addon / platform）

详细架构文档见 [SEEK.md](./SEEK.md)。

---

## 开发

### 构建与测试

```bash
pnpm build:agent     # 构建 agent-runtime（给 VS Code 扩展用）
pnpm build:renderer  # 构建 WebUI 渲染层
pnpm build:ext       # 构建 VS Code 扩展

# 测试（tsx 直跑 scripts/ 下脚本）
pnpm tsx scripts/test-patch-batch.ts
pnpm tsx scripts/test-mode-system.ts
```

常用回归：`test-patch-batch`（22）、`test-sub-agent`（17）、`test-chat-thread`（13）、`test-mode-system`（25）、`test-mode-integration`（15）、`test-worker-library`（113）、`test-instructor-flow`（25）、`test-context-compactor`（36）。

### 扩展开发

- **新增 inner_skill**：在 `src/tools/inner_skills/` 下建目录（`enable.json` + `index.ts` + `translation.ts`），对话中调用 `reload_skills` 热加载；也可用 skill-creator 工具生成骨架
- **新增指令**：在 `src/command/commands/` 下实现 `Command` 接口，并在 `src/command/index.ts` 注册
- **新增 Agent 模式**：在 `src/modes/registry.ts` 注册，在 `src/prompts/addon/` 编写模式提示词
- **新增预制员工**：在 `src/prompts/workers/` 下新建 `.md`（名字 / 性格 / systemPrompt 模板 / 工具组），并在 worker-library 登记

---

## 技能清单（32 个 inner_skills）

- **代码分析**：code-reader、code-edit-detector
- **GitHub**：gh-explorer、github-commit-helper、github-pr-description
- **UI/UX**：github-ui-ux-pro-max（含 6 个子模块）、frontend-helper、icon-lib、html-toolkit
- **Office**：github-docx-official、github-pdf-official、github-pptx-official、github-xlsx-official
- **测试/调试**：github-testing-patterns、github-debugging-strategies、ts-debug
- **API 设计**：github-api-design
- **文档/图片**：pdf-reader、image-identifier、image-crawler
- **Web**：web-accessor、web-crawler、browser-control（真实浏览器驱动）
- **知识库**：kb-query（按工作区隔离的向量索引）
- **系统**：sub-agent、skill-creator、skill-manager、ref-reader、todo-manager、virtual-explorer、worker-library
- **其他**：mc-mod-helper、desk-editor

每个技能有 `enable.json` 控制启停，`SYSTEM_INJECTION.md` 向主 prompt 注入使用说明。

---

## License

MIT
