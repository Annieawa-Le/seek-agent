## 用途

读取其他 skill 中的参考文献（references/ 目录下的内容），支持文件列表、内容读取、字符串搜索和跨 skill 文件查找等功能。

### 可用工具

| 工具 | 功能 |
|------|------|
| `list_refs` | 列出指定 skill 的 references/ 目录下的所有文件（含大小）；不传 skillName 则列出所有有参考文献的 skill |
| `read_ref` | 读取指定 skill 中某个参考文献文件的内容 |
| `search_ref` | 在指定 skill 的 references 目录下的所有文件中搜索关键词，返回匹配的文件名、行号和内容 |
| `find_ref` | 在所有 skills 的 references/ 目录中按文件名模式（glob）查找文件 |
| `ref-reader-prompt-get` | 获取本技能的说明文档（SKILL.md） |

### 安全说明

所有接受 `skillName` / `fileName` 的工具均做了路径穿越防护：
- 只允许字母、数字、短横线和下划线组成的 skill 名称
- 文件名不允许包含路径分隔符或 `..`，不允许以点开头

### 使用流程建议

```
1. list_refs()                              → 查看哪些 skill 有参考文献
2. list_refs(skillName="desk-editor")        → 查看某个 skill 的具体参考文件
3. read_ref(skillName="desk-editor", fileName="architecture.md") → 读取某个参考文件
4. search_ref(skillName="desk-editor", keyword="api")            → 搜索关键词
5. find_ref(pattern="*.md")                                     → 跨 skill 查找 md 文件
```
