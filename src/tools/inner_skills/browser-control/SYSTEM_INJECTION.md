遇到反爬拦截、需要登录、页面为 JS 动态渲染、或需要持续交互（点击/输入/滚动）的场景，优先使用 browser-control 工具（真实浏览器驱动）而非 HTTP 抓取（fetch_page / crawl_site）。

browser-control 的浏览器实例在进程内单例常驻，多轮工具调用共享同一页面状态；使用完毕后记得调用 browser_close 释放。

需要理解页面视觉内容时，用 browser_screenshot 截图后配合 vision_analyze 分析。

使用浏览器操作类工具前，必须先调用 browser_launch 启动浏览器。
