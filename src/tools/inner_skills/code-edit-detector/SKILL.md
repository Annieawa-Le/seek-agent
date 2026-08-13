## 用途

代码编辑辅助检测与修改工具。提供五个能力：

1. **get_function_range** — 按函数名返回整个函数体的起止行范围及完整代码体
2. **find_matching_brace** — 给定某行，若存在 `{` 或 HTML/XML 开标签，找到对应的 `}` 或闭合标签行号
3. **wrap_by** — 用大括号包裹指定行范围，并在 `{` 前插入指定字符串（如 `if (cond)`、`try`），自动处理缩进
4. **wrap_by_label** — 用 HTML/JSX/XML 标签包裹指定行范围（如 `<div className="card"> ... </div>`），自动处理缩进
5. **find_matching_label** — 查找 HTML/JSX/XML 标签的配对行号，支持开→闭与闭→开双向查找、嵌套匹配

### 可用工具

| 工具 | 功能 |
|------|------|
| `get_function_range` | 按函数名称返回整个函数体的行范围（起始行-结束行），附带完整代码体。支持 `ClassName.methodName` 格式定位类方法。 |
| `find_matching_brace` | 给定某行，若该行存在 `{` 或 HTML/XML 开标签，返回对应的 `}` 或闭合标签行号。正确处理嵌套结构。 |
| `wrap_by` | **直接修改文件** — 用 `{ }` 包裹指定行范围，在 `{` 前插入指定字符串。自动检测缩进风格（tab/空格），范围内每行增加一级缩进。 |
| `wrap_by_label` | **直接修改文件** — 用 `<tagName attrs> ... </tagName>` 包裹指定行范围，自动处理缩进。适合 JSX/HTML 嵌套结构。 |
| `find_matching_label` | 查找 HTML/JSX/XML 标签配对行号。行是开标签→返回闭合标签行；行是闭合标签→反向返回开标签行。支持嵌套与指定 tagName。 |
| `code-edit-detector-prompt-get` | 获取本技能说明文档。 |

### 使用流程建议

```
1. get_function_range → 定位编辑目标的范围
2. find_matching_brace / find_matching_label → 确认代码块/标签边界
3. wrap_by / wrap_by_label → 对选定行范围执行包裹操作（嵌套结构优先用标签包裹）
```

### 编辑策略

嵌套结构（JSX/HTML/三元表达式）优先小步编辑：单行 modify、小范围 add/del，包裹用 `wrap_by`/`wrap_by_label`，改前先确认括号/标签配对。语法检查失败时优先看「替换块结构预检」提示。

### 输出格式

**get_function_range**、**find_matching_brace**、**find_matching_label** 返回 JSON 字符串。

**get_function_range 返回字段**:
- `name` — 函数名
- `className` — 所属类（可能为 null）
- `startLine` — 起始行号
- `endLine` — 结束行号
- `type` — 类型: function / method / lambda / arrow
- `params` — 参数列表
- `returnType` — 返回值类型（可能为 null）
- `body` — 完整函数体代码

**find_matching_brace 返回字段**:
- `type` — 匹配类型: "brace" 或 "tag"
- `openBraceLine` / `openLine` — 开括号/开标签所在行
- `closeBraceLine` / `closeLine` — 闭括号/闭合标签所在行
- `closeLineContent` — 该行内容（trimmed）
- `tagName` — (仅 tag 类型) 标签名

**find_matching_label 返回字段**:
- `type` — 匹配类型: "open-to-close" 或 "close-to-open"
- `tagName` — 标签名
- `openLine` / `closeLine` — 开标签/闭合标签所在行
- `openLineContent` / `closeLineContent` — 对应行内容（trimmed）

