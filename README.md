# Seek Agent — 一个能跑的 AI 编程助手（大概）

> **最前提示！非常重要！**
>
> 这个不算正式发行的项目。
>
> **本 Agent 环境没有沙箱，没有隔离，没有危险代码检测，赋予对工作区完整的操作权限！**
>
> 如果你使用本 Agent，则你应该预料到可能会有数据安全事故的发生！

这是一个**本地运行的 AI 编程助手**：本质是一个由 `system prompt + 工具系统` 驱动的 Agent 循环，给它套了终端（Ink）和 Electron 两套界面。TypeScript 全栈，pnpm workspace。工程质量嘛……个人项目，能跑就是胜利。

上面那段警告不是开玩笑：这玩意儿没有沙箱、没有危险代码检测，你要是让它放飞自我，它真的可能把工作区搞乱。**用之前想清楚。**

---

## 有什么

- **工具系统**：文件读写、Patch 编辑（带撤销和语法检查，至少尽力不让你改崩）、命令执行、搜索、Todo、双层记忆
- **32 个技能（inner_skills）**：代码分析、GitHub、UI/UX、Office 文档、Web 浏览、知识库……数量不少，质量参差，能用哪个算哪个
- **记忆系统**：短期工作记忆 + 长期持久知识，旧轮次自动压缩归档，想翻旧账还能召回
- **MCP 集成**：能接 Model Context Protocol 服务

---

## 快速开始

环境要求：Node.js 20+、pnpm 10+（Python 3 / LibreOffice 是可选依赖，缺了部分功能不可用）。

```bash
pnpm install          # 装依赖
cp .env.example .env  # 复制配置模板，填上你的 key
```

最小配置（主模型）：

```env
OPENAI_BASE_URL = https://base.url.here
OPENAI_API_KEY = yourkey
OPENAI_MODEL = deepseek-v4-flash
```

其他可选配置见 `.env.example` 注释：轻量模型（`LITE_MODEL_*`）、Tavily 搜索、视觉模型（`IMAGE_*`）、知识库 Embedding（`EMBEDDING_*`）等。

### 启动

```bash
pnpm dev              # TUI 模式（终端）
dev-electron.bat      # Electron WebUI（Windows：构建前端 + 编译 agent 后打开）
```

---

## 使用

**命令面板**：`Ctrl+P` 打开，输入关键词过滤指令/工具，回车执行，支持鼠标点击。

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+P` | 命令面板 |
| `Ctrl+C` | 中断当前轮次 / 退出 |
| `Ctrl+L` | 清屏 |
| `Ctrl+Q` | 清理工具调用结果 |
| `Ctrl+S` | 保存会话 |
| `Ctrl+W` | 折叠 3 轮前内容 |
| `Ctrl+U` | 清空输入 |
| `Ctrl+D` | 退出 |
| `Tab` / `Ctrl+I` | 中断所有子 agent |

常用指令（`/help` 查看全部）：`/save` `/load` 会话管理、`/mode` 切换模式、`/clear` 清屏。

---

## 开发

```bash
pnpm tsx scripts/test-patch-batch.ts   # 跑测试（tsx 直跑 scripts/ 下脚本）
```

- **新增技能**：在 `src/tools/inner_skills/` 下建目录（`enable.json` + `index.ts` + `translation.ts`），用 `reload_skills` 热加载
- **新增指令**：`src/command/commands/` 下实现 `Command` 接口，在 `src/command/index.ts` 注册
- **新增模式**：`src/modes/registry.ts` 注册，在 `src/prompts/addon/` 编写提示词

架构说明见 [SEEK.md](./SEEK.md)——内容可能过时，以代码为准。

---

## License

MIT

