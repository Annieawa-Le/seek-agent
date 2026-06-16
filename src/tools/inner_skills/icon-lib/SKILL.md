## icon-lib — VS Code Codicons 图标库查询

本技能以 VS Code 使用的 [Codicons](https://github.com/microsoft/vscode-codicons) 图标集为参考数据，提供图标名称搜索、详细查询和列表浏览功能。

Codicons 是 VS Code 内置的 UI 图标系统（MIT 许可），包含 500+ 图标，覆盖文件操作、调试、Git、编辑器布局、符号类型、通知等场景。

### 可用工具

| 工具 | 功能 |
|------|------|
| `search_icons` | 搜索图标名称（模糊匹配主名/别名/codepoint） |
| `get_icon_detail` | 获取单个图标的完整信息（codepoint、CSS class、SVG 链接、使用示例） |
| `list_all_icons` | 浏览所有图标，支持按 codepoint 范围或名称前缀筛选 |

### 使用示例

1. 找类箭头图标 → `search_icons({ keyword: "arrow", max_results: 30 })`
2. 查某个图标的 Unicode → `get_icon_detail({ icon_name: "debug-start" })`
3. 浏览所有调试图标 → `list_all_icons({ prefix: "debug-" })`

### 参考链接

- [Codicons 在线预览](https://microsoft.github.io/vscode-codicons/dist/codicon.html)
- [GitHub 仓库](https://github.com/microsoft/vscode-codicons)
- NPM: `@vscode/codicons`
