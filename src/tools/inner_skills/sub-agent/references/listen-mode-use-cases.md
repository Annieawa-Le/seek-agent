# listen 模式 — 使用场景与提示词模板

listen 模式分两种子模式：`call`（监听工具调用参数）和 `result`（监听工具执行结果）。

## call 模式 — 监听调用参数

在工具执行**前**触发，分析传入的参数是否合理。

### 命令安全监控
> spawn_agent(
>   mode="listen",
>   name="命令安全员",
>   listenMode="call",
>   listenTools=["execute_command"],
>   analyzeTarget="检查每条命令是否存在注入风险、是否访问了敏感路径、是否有潜在破坏性",
>   returnTemplate="风险等级: {{level}}\n问题: {{issue}}\n建议: {{suggestion}}"
> )

### 文件操作审查
> spawn_agent(
>   mode="listen",
>   name="文件操作监控",
>   listenMode="call",
>   listenTools=["replace_file", "create_file"],
>   analyzeTarget="检查文件路径是否在允许的工作区内，是否有覆盖重要文件的危险",
>   returnTemplate="操作: {{operation}}\n风险: {{risk}}\n建议: {{suggestion}}"
> )

## result 模式 — 监听执行结果

在工具执行**后**触发，分析执行结果是否合理。

### Patch 修改审查
> spawn_agent(
>   mode="listen",
>   name="代码审查员",
>   listenMode="result",
>   listenTools=["modify_patch", "add_patch", "del_patch"],
>   analyzeTarget="检查对文件的修改是否合理：是否会引入语法错误、是否遵循项目代码风格、修改逻辑是否正确",
>   returnTemplate="文件: {{file}}\n修改类型: {{type}}\n问题: {{issue}}\n严重程度: {{severity}}"
> )

### 命令结果分析
> spawn_agent(
>   mode="listen",
>   name="命令结果分析",
>   listenMode="result",
>   listenTools=["execute_command"],
>   analyzeTarget="分析命令执行输出是否包含错误信息、异常或意外结果",
>   returnTemplate="命令: {{command}}\n状态: {{status}}\n关键发现: {{finding}}"
> )

### 搜索结果质量检查
> spawn_agent(
>   mode="listen",
>   name="搜索结果验证",
>   listenMode="result",
>   listenTools=["search_content", "search_all_file"],
>   analyzeTarget="检查搜索结果是否为空或过于宽泛，给出搜索优化建议",
>   returnTemplate="搜索关键词: {{query}}\n结果数: {{count}}\n建议: {{suggestion}}"
> )
