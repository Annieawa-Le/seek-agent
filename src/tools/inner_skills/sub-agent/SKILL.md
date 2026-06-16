# sub-agent — 子 AI 模型管理技能

## 用途

允许主模型动态创建和管理子 AI 模型（子 agent），每个子模型拥有独立的 LLM 调用循环和工具列表。支持三种工作模式：**clone**、**mission**、**listen**。

## 可用工具

| 工具 | 功能 |
|------|------|
| `spawn_agent` | 创建/注册一个子 AI 模型，指定模式、名称、可用工具 |
| `agent_task` | 给已创建的子模型委派任务并立即执行 |
| `agent_query` | 查询子模型状态、向子模型提问、或等待子模型完成 |
| `agent_fire` | 销毁/解雇指定名称的子模型 |
| `a_submission` | 子模型内部使用的提交工具，向主模型汇报工作结果 |

## 三种模式详解

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

### listen 模式

子模型**自动监听**主模型对特定工具的调用，在每次调用触发时自动分析并排队提交分析结果。支持两种子模式：

- `call`：在工具执行前分析调用参数
- `result`：在工具执行后分析执行结果

```
spawn_agent(
  mode="listen",
  name="安全监控",
  tools=[],
  listenMode="call",
  listenTools=["execute_command"],
  analyzeTarget="分析每次命令执行是否存在安全风险"
)
```

适用场景：持续监控、安全审计、质量检查等需要旁路观察主模型行为的场景。

## 工作流程

```
1. spawn_agent  →  创建子模型
2. agent_task   →  委派任务并执行
3. a_submission →  子模型完成任务后自动提交结果
4. agent_query  →  查询子模型状态或向子模型提问
5. agent_fire   →  任务完成后销毁子模型
```

## 注意事项

- 子模型拥有独立的 LLM 调用循环（最大 20 轮），不会阻塞主模型
- 子模型的提交在主模型空闲时才会注入（排队机制）
- clone/mission 模式拥有独立的 patch 暂存区，修改直接写入文件
- 退出程序时自动销毁所有子模型
