# browser-control — 真实浏览器驱动

## 用途

用**真实浏览器**（系统 Edge/Chrome，经 playwright-core 驱动）操控页面，解决传统 HTTP 爬虫的两个痛点：

1. **抗反爬**：真实浏览器指纹（UA、Canvas、WebGL、JS 执行环境）与真人无异，比 `fetch_page` 等 HTTP 抓取更难被目标站点识别为爬虫。
2. **可交互、有状态**：浏览器实例在进程内**单例常驻**，AI 可以**多轮持续操作同一个页面**（点击、输入、滚动、等待、执行 JS、截图），而不是一次性抓取就断开。

### 可用工具

| 工具 | 功能 |
|------|------|
| `browser_launch` | 启动/获取浏览器实例（headless/channel/viewport/userDataDir），单例常驻，已启动则直接复用 |
| `browser_navigate` | 导航到指定 URL，返回页面标题与 HTTP 状态码 |
| `browser_click` | 点击元素（支持 CSS / `text=` / `role=` 选择器） |
| `browser_type` | 向输入框输入文本（可先清空、可模拟键入间隔） |
| `browser_press` | 按键（Enter / Tab / Escape / Control+A 等 Playwright key） |
| `browser_scroll` | 滚动页面（方向 / 像素 / 滚动到指定元素） |
| `browser_extract` | 提取页面内容：文本 / HTML / 链接 / 元信息，可限定选择器范围 |
| `browser_screenshot` | 截图保存到 `browser-shots/`，返回路径供视觉模型（vision_analyze）分析 |
| `browser_execute_js` | 在页面执行 JavaScript 并返回结果 |
| `browser_wait` | 等待元素出现 / 可见 / 隐藏（异步加载场景） |
| `browser_status` | 查看浏览器状态：是否运行、URL、标题、页面数 |
| `browser_close` | 关闭浏览器实例并释放资源 |
| `browser_tabs` | 列出所有标签页（序号/URL/标题/焦点标记），用于多标签页场景 |
| `browser_switch_tab` | 切换焦点到指定标签页（index 来自 browser_tabs），后续工具作用于新焦点页 |
| `browser-control-prompt-get` | 获取本技能的说明文档（SKILL.md） |

## 使用流程建议

```
1. 启动浏览器       → browser_launch(headless=false)
2. 导航到目标页面    → browser_navigate(url="https://example.com")
3. （可选）等待加载  → browser_wait(selector="#content")
4. 查看状态         → browser_status()
5. 交互操作         → browser_click(selector="text=登录") / browser_type(selector="#username", text="...")
6. 提取内容         → browser_extract(mode="text") / browser_screenshot(path="browser-shots/page.png")
7. 用完释放         → browser_close()
```

**典型多轮操作示例**（登录 → 搜索 → 读取结果 → 截图）：

```
browser_launch()
browser_navigate("https://example.com/login")
browser_type("#username", "my_account")
browser_type("#password", "******")
browser_click("button[type=submit]")
browser_wait(".search-box", timeout=10000)
browser_type(".search-box", "关键词")
browser_press("Enter")
browser_wait(".results")
browser_extract(mode="links")
browser_screenshot(fullPage=true)
```

## 与 web-crawler 的对比

| 维度 | web-crawler | browser-control |
|------|-------------|-----------------|
| 方式 | Node 原生 fetch 抓取 HTML | 真实浏览器驱动（playwright-core + Edge/Chrome） |
| 状态 | 无状态，每次独立 | **有状态**，单例常驻，多轮共享同一页面 |
| 速度 | 快（纯 HTTP） | 慢（完整浏览器渲染） |
| 交互 | 不支持 | 点击 / 输入 / 滚动 / 按键 / 执行 JS |
| 反爬 | 易被识别（无 JS 指纹） | **真实指纹，抗反爬** |
| 适用 | 快速抓静态内容 | 登录、动态渲染、反爬站点、需要视觉理解的场景 |

**选择建议**：抓静态公开页面用 web-crawler（快）；遇到反爬、需要登录、页面 JS 动态渲染、或需要持续交互操作的场景，用 browser-control。

## 注意事项

- **首次使用必须先调用 `browser_launch`**，否则其他工具会提示「浏览器尚未启动」。
- 浏览器实例**常驻**进程内，使用完毕后应调用 `browser_close` 释放资源（避免占用内存）。
- 截图默认保存到工作区 `browser-shots/` 目录（自动创建）。
- `headless` 默认 `false`（有头模式便于调试）；部署在无显示器服务器时可设 `true`。
- 依赖系统已安装的 **Edge 或 Chrome**（优先 msedge，自动回退 chrome / 可执行文件 / 默认浏览器）。
- 部分站点对自动化有检测，若被拦截可尝试 `userDataDir` 持久化登录态（类似真人浏览器环境）。

