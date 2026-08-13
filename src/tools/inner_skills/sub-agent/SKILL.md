# sub-agent — 子 AI 模型管理技能

## 用途

允许主模型动态创建和管理子 AI 模型（子 agent），每个子模型拥有独立的 LLM 调用循环和工具列表。支持两种工作模式：**clone**、**mission**。

## 可用工具

| 工具 | 功能 |
|------|------|
| `spawn_agent` | 创建/注册一个子 AI 模型，指定模式、名称、可用工具 |
| `agent_task` | 给已创建的子模型委派任务并立即执行 |
| `agent_query` | 查询子模型状态、向子模型提问、或等待子模型完成 |
| `agent_fire` | 销毁/解雇指定名称的子模型 |
| `a_submission` | 子模型内部使用的提交工具，向主模型汇报工作结果 |

## 两种模式详解

### clone 模式

子模型继承主模型的**完整对话上下文**，紧接一条身份转换说明（告知子模型它的新身份和可用工具），然后传入任务。

```
spawn_agent(mode="clone", name="分析助手", tools=["read_file","search_content"])
agent_task(name="分析助手", task="分析 src/agent.ts 中的工具调用流程")
```

适用场景：需要子模型掌握主模型完整对话背景来执行任务时。

### mission 模式

子模型使用**独立的系统提示词**，主模型传入上下文和任务（作为 user 消息）。身份描述注入到系统提示词头部。

```
spawn_agent(
  mode="mission",
  name="代码审查员",
  tools=["read_file","scanning_function"],
  systemPrompt="你是一位严格的代码审查专家",
  contextAndTask="请审查以下模块的代码..."
)
```

适用场景：子模型需要特定领域角色和知识，但不必了解主模型的完整对话历史。

### instructor 模式

子模型作为开发指导，在主模型每轮工作完成后发散思维提出建议。instructor 拥有独立的对话上下文，每次调用时追加主模型的最新输出。

```
spawn_agent(
  mode="instructor",
  name="开发指导",
  requirement="对下一步开发提出建设性建议",
  maxRounds=3
)
```

适用场景：在主模型每轮工作后补充思路，保持项目方向感。

#### 异步信号机制（v2）

主模型一轮完成后向 instructor 发信号（fire-and-forget），**不阻塞主循环**：

1. `triggerInstructorAfterRound` 同步派发信号，立即返回
2. instructor 在后台独立执行 LLM 调用（有自己的 AbortController，可被 `agent_fire` / agent 退出中断）
3. 完成后把建议**作为用户输入直接 push 进 inputQueue，开启主模型下一轮**（保持"建议 = 用户输入"的语义）
4. 建议在 UI 上渲染为**用户样式 + 小鲸鱼标志**的气泡（`role: 'instructor'`）

防重入：instructor 正在运行（`status === 'running'`）时跳过本次信号，避免建议堆积。
中断处理：fire / agent 退出会 abort 后台流，AbortError 视为正常结束，不产生建议也不污染状态。

#### 提示词自定义

instructor 的 system prompt 模板在 `src/prompts/INSTRUCTOR.md`，可直接编辑（每次执行读盘，保存即生效）。
占位符 `{{requirement}}`（发散方向要求，来自 spawn_agent 的 requirement）与 `{{extraInstruction}}`（额外指导，来自 systemPrompt）会在执行时自动替换。

## 工作流程

```
1. spawn_agent  →  创建子模型
2. agent_task   →  委派任务并执行
3. a_submission →  子模型完成任务后自动提交结果
4. agent_query  →  查询子模型状态或向子模型提问
5. agent_fire   →  任务完成后销毁子模型
```

## 注意事项

- 子模型持续运行直到调用 `a_submission` 提交结果（主动 `agent_fire` 销毁时立即终止）
- 子模型的工具调用直接使用主系统全局注册的工具（`add_patch` / `del_patch` / `modify_patch` 等）
- 子模型的提交在主模型空闲时才会注入（排队机制）
- 退出程序时自动销毁所有子模型





