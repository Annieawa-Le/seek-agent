# src/prompts/ 提示词目录说明

本目录集中存放 seek-agent 运行所需的全部提示词（system prompt）文件。**所有 `.md` 文件均为每次使用前实时读盘**，修改保存后立即生效（无需重启进程），只有改到加载它们的代码（`src/agent.ts`、`src/modes/`、`src/illusion_agent.ts` 等）才需要重启。

## 目录总览

```
src/prompts/
├── Prompts.md              ← 本索引（供使用者参考，不被代码加载）
├── MAIN.md                 ← 主提示词：核心人格与协作规范
├── WORKFLOW.md             ← 工作流规范：todo / patch / 记忆 / 命令准则
├── INSTRUCTOR.md           ← Instructor（开发引导员）子 agent 提示词模板
├── IDENTITY_CARD.md        ← 会话身份卡生成提示词（跨会话协作用）
├── ILLUSION_EXECUTOR.md    ← 100% AI 模式的后台执行器提示词
├── platform/               ← 平台特定命令准则（按操作系统条件加载一份）
│   ├── WINDOWS.md
│   ├── MACOS.md
│   └── LINUX.md
├── addon/                  ← 模式行为准则 / 领域附加提示词
│   ├── KB.md               ← 知识库模式（已挂载）
│   ├── MANAGER.md          ← Manager 模式（已挂载）
│   ├── WORKER.md           ← 打工人模式（已挂载）
│   ├── HALLUCINATION.md    ← 100% AI 模式主模型世界观（已挂载）
│   ├── FRONT_END.md        ← ⚠️ 预留：前端开发领域指导（未挂载）
│   └── MOD_JAVA.md         ← ⚠️ 预留：Minecraft 模组领域指导（未挂载）
└── workers/                ← 预制员工库（Manager 模式可 spawn 的下属）
    ├── README.md           ← 员工库说明与新增员工教程
    └── *.md                ← 7 位员工：code-implementer / code-reviewer / bug-fixer / tester / researcher / documenter / social-fish
```

## 根目录文件

| 文件 | 用途 | 谁加载 | 生效时机 |
|------|------|--------|----------|
| `MAIN.md` | 主提示词：AI 人格、工程原则、输出格式、协作规范 | `src/agent.ts` `loadDefaultPrompts()` | 每次启动/重载 prompt；**会被 manager/worker 等 mainReplacement 模式整体替换** |
| `WORKFLOW.md` | 工作流规范：patch 工具用法、todo 系统、记忆工具、命令准则 | `src/agent.ts` | 拼在 MAIN 之后，常驻 |
| `INSTRUCTOR.md` | instructor（开发引导员）子 agent 的 system prompt 模板 | `src/tools/inner_skills/sub-agent/runner.ts` | 每次 instructor 执行读盘；支持 `{{requirement}}` / `{{extraInstruction}}` 占位符 |
| `IDENTITY_CARD.md` | 会话身份卡师提示词：把对话压缩成结构化身份卡，供跨会话协作 | `src/tools/identity-card.ts` | 每次生成身份卡读盘 |
| `ILLUSION_EXECUTOR.md` | 100% AI 模式的后台执行器：替主模型的幻觉工具调用"圆梦" | `src/illusion_agent.ts` | 每次转派幻觉调用时读盘 |

## platform/（按操作系统加载一份）

| 文件 | 适用平台 | 谁加载 |
|------|----------|--------|
| `WINDOWS.md` | win32 | `src/agent.ts`（按 `process.platform` 选择） |
| `MACOS.md` | darwin | 同上 |
| `LINUX.md` | linux | 同上 |

内容为平台相关命令准则（如 Windows 下的 cmd 使用规范），追加在 MAIN 之后。

## addon/（模式行为准则）

| 文件 | 模式 | 形态 | 谁加载 | 激活方式 |
|------|------|------|--------|----------|
| `KB.md` | 知识库模式 | promptAddon（附加在 MAIN 后） | `src/modes/index.ts` `readAddon()` | `/mode kb` |
| `MANAGER.md` | Manager 模式 | mainReplacement（替换 MAIN） | 同上 | `/mode manager` |
| `WORKER.md` | 打工人模式 | mainReplacement（替换 MAIN） | 同上 | `/mode worker` |
| `HALLUCINATION.md` | 100% AI 模式 | 主模型世界观（不经过 modes 拼接） | `src/illusion_agent.ts` `readPrompt()` | `/mode hallucination` |

> `mainReplacement` 模式激活时**不再附加** MAIN.md 与其余 promptAddon；`promptAddon` 模式激活时拼在 MAIN 之后。

⚠️ 预留未挂载：`FRONT_END.md`（前端开发指导）与 `MOD_JAVA.md`（Minecraft 模组指导）是设计阶段预留的领域提示词，当前**没有任何模式引用**，修改它们不会生效。若需启用，应注册对应模式或在 `loadDefaultPrompts()` 中按条件加载。

## workers/（预制员工库）

7 位员工，每位一个 `<id>.md`，内含 `## 名字`、`## 性格人设` 与 `----SYSTEM_PROMPT_START/END----`（systemPrompt 模板）、`----TOOLS_START/END----`（推荐工具组）标记。由 `src/tools/inner_skills/worker-library/` 读取，Manager 模式通过 `list_workers` / `spawn_worker` 使用。新增员工教程见 `workers/README.md`。

## 快速模式下的加载顺序

```
MAIN.md（或激活模式的 mainReplacement）
→ platform/{WINDOWS|MACOS|LINUX}.md（按平台）
→ WORKFLOW.md
→ 已启用技能列表（自动生成，来自 inner_skills/enable.json）
→ 各技能 SYSTEM_INJECTION.md（来自 inner_skills/*/SYSTEM_INJECTION.md）
→ 激活模式的 promptAddon（如 KB.md）
```

## 常见疑问

- **100% AI 模式的提示词在哪？** 分两处：主模型的"万能工具环境"世界观在 `addon/HALLUCINATION.md`，后台执行器的职责与输出格式在根目录 `ILLUSION_EXECUTOR.md`。两者都可直接编辑、即时生效。
- **改了 .md 为什么不生效？** 确认改的是上表"谁加载"对应的路径（大小写敏感）；若改的是代码（如注册新模式），需重启 agent 进程。
- **ALL_HALLUCINATION.md 去哪了？** 它原是 100% AI 模式的设计想法笔记（非生效提示词），已移出本目录至 `docs/ALL_HALLUCINATION.md`。
