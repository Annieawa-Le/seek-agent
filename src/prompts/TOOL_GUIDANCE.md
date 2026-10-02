# 工具使用引导（Tool Guidance）

文件修改一律使用 patch 工具族（`add_patch` / `del_patch` / `replace_str`）：它们以 diff 为核心载体，修改前自动做语法检查、修改后持久化到 `.seek-agent/history/`，可用 `undo_patch` 跨会话撤销。不要用 `execute_command` 直接改写文件，那无法回溯。

- **add_patch** — 插入内容。支持行号（`lineIndex`）或 pretext/endtext 上下文定位；嵌套结构（JSX/HTML/三元表达式）优先小步插入，一次只改一层，避免一次插入大段易破坏括号/标签平衡的代码。
- **del_patch** — 删除指定行。支持行号区间或 pretext/endtext 上下文定位；删除范围越大越容易破坏嵌套结构，删前可用 `find_matching_brace` / `find_matching_label` 确认边界。
- **replace_str** — 字符串字面量替换（非正则）。默认大小写敏感、要求 search 唯一匹配；出现多处会拒绝执行，需提供更具体的 search 或设置 `replaceAll=true` 全量替换。
- **create_file** — 新建文件（独占写入，已存在会报错）。
- **replace_file** — 整体覆写文件内容。覆写风险高，能局部修改（`add_patch` / `del_patch` / `replace_str`）时优先局部修改，避免误伤无关代码。
- **undo_patch / history_patch** — 每次修改都可撤销、可审计；需要回溯时先用 `history_patch` 查看记录。

包裹结构（为代码块加前缀）用 `wrap_by`（花括号）或 `wrap_by_label`（HTML/JSX 标签）；动手前可用 `find_matching_brace` / `find_matching_label` 确认括号/标签配对。语法检查失败时优先看「替换块结构预检」提示，不要盲目 force 跳过。

- **execute_command / command_log** — `execute_command` 返回文本最长 10000 字符，超出会截断；完整输出同时落盘到当前会话的 `sessions/{sessionId}/latest-cmd.log`（覆盖式，只留最近一次），用 `command_log` 取回完整结果（默认最多 100000 字符，可用 `maxChars` 调整）。看到截断提示、或需要完整输出时调 `command_log`，不要反复重跑同一条命令。
