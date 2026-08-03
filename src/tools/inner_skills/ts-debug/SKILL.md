# ts-debug — TS 项目调试工具集

## 用途

封装调试 TypeScript 项目时的高频命令（类型检查、跑测试脚本、语法检查、构建），
统一走 Node 子进程直跑（`spawn(process.execPath, ...)`），**不经 cmd 管道**，
输出保持 UTF-8 无损——解决 Windows 下 `findstr`/管道对中文输出乱码、编码误判的问题。

### 可用工具

| 工具 | 功能 |
|------|------|
| `ts_typecheck` | 类型检查 `tsc --noEmit`（支持按键路径片段过滤错误 + 错误总数；`cwd=electron/renderer` 时用渲染层 `tsc -b --noEmit`） |
| `ts_run_test` | 运行 `scripts/` 下的 tsx 测试脚本（自动补全 `scripts/` 前缀与 `.ts` 后缀，返回退出码与输出） |
| `ts_node_check` | 对 JS/CJS 文件做语法检查（`node --check`，用于验证 `electron/main.js`、`preload.cjs` 等改动） |
| `ts_build` | 构建：`renderer`=渲染层 vite build（默认）、`renderer:typecheck`=渲染层 tsc、`agent`=build:agent |
| `ts-debug-prompt-get` | 获取本技能说明文档 |

### 典型用法

```
1. 修改代码后验证类型：ts_typecheck() → 看错误总数是否等于基线；ts_typecheck(filter="context-compactor") → 只看该文件错误
2. 跑回归测试：ts_run_test(script="test-context-compactor") → 退出码 0 即通过
3. 改 main.js/preload.cjs 后：ts_node_check(file="electron/main.js")
4. 渲染层改动后：ts_typecheck(cwd="electron/renderer") + ts_build(target="renderer")
```

### 为什么不用 execute_command

`execute_command` 走 cmd shell + GBK 解码，管道/重定向时 UTF-8 中文输出易乱码
（此前 `findstr /C:"全部通过"` 匹配失败的根因）。本技能直接 spawn Node 可执行文件，
参数不拼命令行（无引号/空格转义问题），子进程 cwd 由工具内部指定，输出天然 UTF-8。

### 注意事项

- 依赖解析基于当前工作区根（`getWorkspaceRoot()`）：`node_modules/typescript/bin/tsc`、`--import tsx`、渲染层 `node_modules/vite/bin/vite.js`
- tsc 超时 180s、测试脚本超时 300s，超时自动 kill 子进程
- 输出默认截断（错误列表 60 行 / 测试输出 6000 字符），超长会提示截断
