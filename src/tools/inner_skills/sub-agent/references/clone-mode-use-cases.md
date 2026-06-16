# clone 模式 — 使用场景与提示词模板

## 适用场景

子模型需要理解**主模型的完整对话背景**才能完成任务时。
典型场景：代码审查、上下文敏感的分析、延续当前工作。

## 常用提示词模板

### 代码审查
> spawn_agent(mode="clone", name="代码审查员", tools=["read_file", "scanning_function", "search_content"])
> agent_task(name="代码审查员", task="请审查我刚刚讨论的这段代码，检查：1）潜在的 bug；2）性能问题；3）代码风格一致性。给出改进建议。")

### 并行探索
> spawn_agent(mode="clone", name="问题排查", tools=["read_file", "search_content", "execute_command"])
> agent_task(name="问题排查", task="我正在排查这个模块的问题，请你去看看相关的配置文件和环境变量，找出可能导致问题的原因。")

### 文档撰写
> spawn_agent(mode="clone", name="文档员", tools=["read_file", "read_lines"])
> agent_task(name="文档员", task="基于我们刚刚讨论的设计，为此模块写一份简短的使用文档，包括：概述、API 说明、使用示例。")

### 方案对比
> spawn_agent(mode="clone", name="方案评测", tools=["read_file"])
> agent_task(name="方案评测", task="我们刚刚讨论了两个实现方案，请结合当前代码库的结构，分析各方案的优缺点和兼容性。")
