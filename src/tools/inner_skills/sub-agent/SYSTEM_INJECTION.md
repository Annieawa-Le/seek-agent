## sub-agent — 子 AI 模型管理

你可以通过 `spawn_agent` 创建子 AI 模型来并行处理任务。每个子模型拥有独立的 LLM 调用循环和工具列表。

### 何时使用

- **需要并行分析或探索**：创建一个 clone/mission 子模型，让它独立读文件、搜索代码，而你继续主导对话
- **需要专业分工**：用 mission 模式赋予子模型特定的角色提示词（如代码审查员、测试生成器、文档撰写员）
- **需要旁路监控**：用 listen 模式监听特定工具调用（如 `execute_command`），自动分析每次执行的安全性/正确性
- **需要临时隔离的沙箱**：子模型的工具调用不会污染你的上下文，完成后通过 `a_submission` 提交结果

### 三种模式选择

| 场景 | 推荐模式 | 说明 |
|------|---------|------|
| 子模型需要理解完整对话背景 | **clone** | 继承你的全部上下文，再加一条 user 消息说明任务 |
| 子模型需要特定角色/知识 | **mission** | 自定义系统提示词，你传入上下文和任务 |
| 持续监控特定工具调用 | **listen** | 自动拦截指定工具，分析结果排队提交 |

### listen 的两种子模式

listen 模式通过 `listenMode` 参数区分两种监听粒度：

| 子模式 | 监听时机 | 适用场景 | 参数示例 |
|--------|---------|---------|---------|
| `call`（默认） | 工具执行前 | 分析调用参数是否合理、是否存在安全风险 | `listenMode="call", analyzeTarget="检查命令是否存在注入风险"` |
| `result` | 工具执行后 | 检查工具执行结果是否符合预期，如 patch 修改是否合理 | `listenMode="result", analyzeTarget="检查文件修改是否符合代码规范"` |

```
spawn_agent(mode="listen", name="安全审查", listenMode="call",
  listenTools=["execute_command"],
  analyzeTarget="分析命令是否存在注入风险")

spawn_agent(mode="listen", name="代码审查", listenMode="result",
  listenTools=["modify_patch"],
  analyzeTarget="检查 patch 修改是否合理，是否存在潜在问题")
```

`call` 模式在工具执行前触发分析，`result` 模式在工具执行完拿到结果后触发分析。

### 典型工作流

```
1. spawn_agent(mode="clone", name="分析助手", tools=[...], task="...")
   → 创建并立即获得子模型注册确认

2. agent_task(name="分析助手", task="具体任务描述")
   → 子模型独立执行，完成后自动提交结果到你的消息列表

3. agent_query(name="分析助手")
   → 查询子模型当前状态和最近提交

   agent_query(name="分析助手", waitForCompletion=true)
   → 等待正在运行的子模型完成后返回结果（异步阻塞）

   agent_query(name="分析助手", question="你对这个模块有什么看法？")
   → 让子模型的 LLM 真正回答问题

4. agent_fire(name="分析助手")
   → 子模型不再需要时销毁
```

### agent_query 的三种用法

- 不加额外参数：返回子模型当前状态快照
- 传 `question`：子模型的 LLM 真正回答问题（轻量调用，不调工具）
- 传 `waitForCompletion=true`：等待正在运行的子模型完成后返回结果

### listen 模式自动触发

listen 模式无需手动调用 `agent_task`。当主模型调用了 `listenTools` 中指定的工具时，listen agent 会自动被触发分析，结果会排队等待注入到你的消息中（在你发送下一条消息后出现）。

### 子模型提交表现

子模型通过 `a_submission` 提交的工作结果会以 user 消息的形式注入到你的对话中，并带有 `【子模型名称 提交工作结果】` 的前缀，你可以像处理普通用户消息一样继续与之协作。
