# code-graph — 代码图谱技能

双引擎静态分析工具集，为模型提供代码结构感知能力：
符号提取、引用查找、调用链追踪、文件依赖与影响面分析。

## 适用场景

- **修改前评估**：`blast_radius` 查看改动影响面，避免漏改/误改
- **理解调用关系**：`trace_callers` / `trace_callees` / `trace_chain` 追踪函数调用链
- **定位定义**：`read_symbol` 读取符号完整定义，`list_symbols` 总览文件结构
- **重构安全**：`find_references` 找全引用点，`file_deps` 了解模块依赖

## 工具清单

| 工具 | 功能 |
|------|------|
| `list_symbols` | 列出文件所有符号（函数/类/方法/接口/类型/枚举/变量/导入），含行号与签名 |
| `read_symbol` | 读取符号完整定义（签名 + 文档 + 代码体），支持 `ClassName.method` |
| `find_references` | 查找符号在项目中的所有引用位置（跨文件） |
| `trace_callers` | 反向调用链：谁调用了该函数 |
| `trace_callees` | 正向调用链：该函数调用了谁 |
| `trace_chain` | 完整调用链追踪（BFS，可设深度） |
| `file_deps` | 文件依赖分析（import/require/type，解析实际文件路径） |
| `blast_radius` | 影响面分析：修改某文件/符号会影响哪些文件 |

## 技术说明

- **引擎**：双引擎按文件类型自动分发——TS/TSX/JS/JSX 走 TypeScript 编译器 API（`ts.Program` + AST + checker，语义级）；Java/C/C++ 走 tree-sitter WASM 解析器（`web-tree-sitter` + `tree-sitter-wasms`，语法级）
- **缓存**：TS 侧按项目根缓存 Program（文件 mtime 变化自动失效，最多 8 个根）；tree-sitter 侧按文件缓存语法树+源文本（同样按 mtime 失效）
- **精度**：TS/TSX/JS/JSX 为语义级（区分声明与引用、解析模块路径）；Java/C/C++ 为语法级（无类型解析，同名/重载近似匹配，调用链为文本级）
- **覆盖**：`.java` / `.c` / `.h` / `.cpp` / `.cc` / `.cxx` / `.hpp` / `.hh` / `.hxx`
- **性能**：WASM 首次加载需初始化解析器（数百 ms），之后按文件缓存；大型仓库跨文件扫描仍是一次性开销

## 与 code-reader 的分工

- **code-reader**：按结构分块读文件（函数/类/标签扫描），适合快速浏览
- **code-graph**：跨文件语义分析（引用/调用链/影响面），适合修改前评估和重构

