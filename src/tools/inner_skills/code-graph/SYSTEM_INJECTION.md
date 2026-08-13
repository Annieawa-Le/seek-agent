需要理解代码结构、评估修改影响、追踪调用关系时，优先使用 code-graph 技能工具（list_symbols / read_symbol / find_references / trace_callers / trace_callees / trace_chain / file_deps / blast_radius）：
- 修改函数前先用 `trace_callers` 确认谁在调用它，用 `blast_radius` 评估影响面
- 想了解某函数内部逻辑先用 `trace_callees` 看它调用了谁
- 改代码前用 `find_references` 找全所有引用点，避免漏改
- 对 TS/TSX/JS/JSX 文件为语义级精度；Java/C/C++ 文件自动走 tree-sitter 引擎（语法级近似，同名/重载可能误报，注意甄别）

