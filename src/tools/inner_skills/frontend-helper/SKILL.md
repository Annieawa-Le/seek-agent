## 用途

前端开发辅助工具集，提供组件代码生成、HTML/模板结构分析、CSS/样式代码生成等能力，帮助快速搭建前端项目骨架和进行代码审查。

### 可用工具

| 工具 | 功能 |
|------|------|
| `generate_component` | 生成前端组件代码骨架，支持 React（函数/类组件）、Vue（选项式/组合式 API）、原生 HTML 等多种框架风格。自动处理导入语句、Props 类型定义、样式绑定等样板代码。 |
| `generate_styles` | 生成 CSS/SCSS/Tailwind 样式代码，支持常见布局模式（flex、grid、响应式断点）、主题变量、动画关键帧等。 |
| `analyze_template` | 分析 HTML/模板代码的结构层级，检测常见的可访问性（ARIA）、语义化标签使用、嵌套深度等问题，并给出改进建议。 |

### 参考文件

`references/` 目录下收录了业界常用的 CSS 主题/工具文件，可供生成代码时参考：

| 文件 | 说明 |
|------|------|
| `modern-normalize.css` | Sindre Sorhus 出品的现代 CSS reset，更轻量的 normalize |
| `tailwind-preflight.css` | Tailwind CSS 的 base/reset 层（preflight），utility-first 风格的基础样式 |
| `bootstrap-theme-vars.css` | Bootstrap 5.3 的完整设计令牌（CSS 自定义属性），含 light/dark 双主题 |
| `github-markdown.css` | GitHub Primer CSS 的 markdown 渲染样式，适合文档型页面排版 |
| `common-keyframes.css` | 常用 CSS 动画关键帧，含 fade/slide/zoom/bounce/spin/shimmer 等 |

### 使用流程建议

```
1. 调用 generate_component 生成组件骨架
2. 结合参考文件中的设计令牌调整样式
3. 用 analyze_template 审查生成的 HTML 结构质量
4. 或调用 generate_styles 辅助生成布局/动画代码
```
