# code-edit-detector — 行为指引

## 工具选用指引

- **需要知道某个函数/方法的起止行** → 调用 `get_function_range`
  - 如果函数名不唯一（重载/同名方法），输出会列出所有候选项，提示用 `ClassName.methodName` 格式重新调用
  - `fileType` 参数根据文件扩展名填写即可（`ts`, `py`, `c`, `java`, `html` 等）
- **需要知道某行 `{` 匹配到哪一行关闭**，或 **某 HTML 开标签匹配到哪一行闭合** → 调用 `find_matching_brace`
  - 传入的目标行应包含 `{` 或 `<tagName>`（非自闭合）
  - 工具会优先检测花括号，其次检测 HTML/XML 标签
- **需要用 `{ }` 包裹若干行，并在前面加个前缀（如 try/if/for）** → 调用 `wrap_by`
  - 该工具会**直接修改文件**
  - 自动处理缩进：检测文件的缩进风格（tab/空格），范围内每行增加一级缩进
  - 如果 `wrapString` 为空字符串，则只生成裸 `{ }` 包裹

## 配合使用场景

1. 编辑已有函数时：先用 `get_function_range` 获取原函数范围，再用 `find_matching_brace` 确认块边界
2. 定位插入点：用 `find_matching_brace` 在花括号行找到函数体结束位置
3. 包裹代码：用 `wrap_by` 对选定行范围添加 try-catch / if 条件 / for 循环等结构

## 已知限制

- `get_function_range` 依赖 `code-reader` 的 `aux_parser`，不支持的类型会提示可用列表
- `find_matching_brace` 仅检测每行的第一个 `{`。若一行有多个 `{`，优先匹配首个。
- HTML 标签匹配区分标签名大小写（`<Div>` 和 `<div>` 视为不同标签）
- `wrap_by` 是破坏性操作，直接覆写文件。调用前建议确认行号范围无误。
