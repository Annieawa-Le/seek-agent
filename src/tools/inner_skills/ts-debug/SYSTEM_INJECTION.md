调试 TypeScript 项目时优先使用 ts-debug 技能工具（ts_typecheck / ts_run_test / ts_node_check / ts_build），而不是手敲 cmd 命令：
- 类型检查用 `ts_typecheck(filter="文件名片段")` 定位特定文件错误，返回错误总数便于与基线对比
- 跑测试用 `ts_run_test(script="test-xxx")`，自动补全 scripts/ 前缀与 .ts 后缀
- 校验 main.js / preload.cjs 等 JS 改动用 `ts_node_check(file=...)`
这些工具走 Node 子进程直跑，UTF-8 无损，避免 Windows cmd 管道对中文输出的乱码问题。
