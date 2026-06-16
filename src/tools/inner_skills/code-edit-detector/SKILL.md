## 用途

代码编辑辅助检测与修改工具。提供三个能力：

1. **get_function_range** — 按函数名返回整个函数体的起止行范围及完整代码体
2. **find_matching_brace** — 给定某行，若存在 `{` 或 HTML/XML 开标签，找到对应的 `}` 或闭合标签行号
3. **wrap_by** — 用大括号包裹指定行范围，并在 `{` 前插入指定字符串（如 `if (cond)`、`try`），自动处理缩进

### 可用工具

| 工具 | 功能 |
|------|------|
| `get_function_range` | 按函数名称返回整个函数体的行范围（起始行-结束行），附带完整代码体。支持 `ClassName.methodName` 格式定位类方法。 |
| `find_matching_brace` | 给定某行，若该行存在 `{` 或 HTML/XML 开标签，返回对应的 `}` 或闭合标签行号。正确处理嵌套结构。 |
| `wrap_by` | **直接修改文件** — 用 `{ }` 包裹指定行范围，在 `{` 前插入指定字符串。自动检测缩进风格（tab/空格），范围内每行增加一级缩进。 |
| `code-edit-detector-prompt-get` | 获取本技能说明文档。 |

### 使用流程建议

```
1. get_function_range → 定位编辑目标的范围
2. find_matching_brace → 确认代码块边界
3. wrap_by → 对选定行范围执行包裹操作
```

### 输出格式

**get_function_range** 和 **find_matching_brace** 返回 JSON 字符串。

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
