# icon-lib 行为指引

启用 icon-lib 技能后，在以下场景建议使用它：

1. 当用户在找某个图标的名称或 codepoint 时 → 优先用 `search_icons`
2. 当用户想了解某个图标在 HTML/CSS/React 中怎么用 → 用 `get_icon_detail`
3. 当用户想浏览某个分类的图标 → 用 `list_all_icons` 加 prefix 参数

数据来源是 VS Code Codicons (CC-BY-4.0)，所有图标名以 `src/icons/` 下的 SVG 文件名为准。如果有别名（比如 `add` 同时也是 `plus`），`search_icons` 会一并匹配。

图标 CSS class 格式：`codicon codicon-<name>`
SVG sprite 引用：`<use xlink:href="codicon.svg#<name>"/>`
