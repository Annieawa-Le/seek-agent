# code-edit-detector — 行为指引

## 工具选用指引

- **需要知道某个函数/方法的起止行** → 调用 `get_function_range`
  - 如果函数名不唯一（重载/同名方法），输出会列出所有候选项，提示用 `ClassName.methodName` 格式重新调用
  - `fileType` 参数根据文件扩展名填写即可（`ts`, `py`, `c`, `java`, `html` 等）
- **需要知道某行 `{` 匹配到哪一行关闭** → 调用 `find_matching_brace`（花括号优先，也支持 HTML/XML 标签）
- **需要知道某 HTML/JSX 开标签/闭合标签匹配到哪一行** → 调用 `find_matching_label`（只处理标签，支持开→闭与闭→开双向查找，可指定 tagName 处理一行多标签）
- **需要用 `{ }` 包裹若干行，并在前面加个前缀（如 try/if/for）** → 调用 `wrap_by`
  - 该工具会**直接修改文件**
  - 自动处理缩进：检测文件的缩进风格（tab/空格），范围内每行增加一级缩进
  - 如果 `wrapString` 为空字符串，则只生成裸 `{ }` 包裹
- **需要用 HTML/JSX/XML 标签包裹若干行** → 调用 `wrap_by_label`
  - 该工具会**直接修改文件**
  - 参数：tagName 填标签名（div/span/section/MyComponent），attrs 填属性字符串
  - 自动处理缩进，生成 `<tagName attrs> ... </tagName>`

## 编辑策略（重要——嵌套结构修改前必读）

- **嵌套结构（JSX/HTML/三元表达式/回调）优先小步编辑**：单行 modify、小范围 add/del，避免一次提交大段 replaceLines。替换块越大，括号/标签不平衡的概率越高。
- **包裹已有代码用 `wrap_by` / `wrap_by_label`，不要手写包裹行**——模型手写开/闭标签时极易引入不平衡。
- **修改前先用 `find_matching_brace` / `find_matching_label` 确认边界**：改 JSX 前确认 `{` 和标签的配对范围。
- **语法检查失败时**：优先看报错开头的「替换块结构预检」——它指出你的 replaceLines 自身哪行括号/标签不平衡；再看每条错误的「[替换区域内/之后]」标注判断错误与替换块的关系，不要怀疑语法检查器或行号本身。

## 配合使用场景

1. 编辑已有函数时：先用 `get_function_range` 获取原函数范围，再用 `find_matching_brace` 确认块边界
2. 定位插入点：用 `find_matching_brace` 在花括号行找到函数体结束位置
3. 包裹代码：用 `wrap_by` 对选定行范围添加 try-catch / if 条件 / for 循环等结构；用 `wrap_by_label` 包裹 HTML/JSX 标签

## 已知限制

- `get_function_range` 依赖 `code-reader` 的 `aux_parser`，不支持的类型会提示可用列表
- `find_matching_brace` 仅检测每行的第一个 `{`。若一行有多个 `{`，优先匹配首个。
- HTML 标签匹配区分标签名大小写（`<Div>` 和 `<div>` 视为不同标签）
- `wrap_by` / `wrap_by_label` 是破坏性操作，直接覆写文件。调用前建议确认行号范围无误。

