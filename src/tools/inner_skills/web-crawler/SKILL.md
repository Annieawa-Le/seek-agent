## 用途

轻量级网页爬取工具，**无需外部 API Key**。基于 Node.js 原生 `fetch`，提供网页内容抓取、链接提取、站点爬取和免费网页搜索能力，可替代 Tavily 的大部分日常使用场景。

### 可用工具

| 工具 | 功能 |
|------|------|
| `fetch_page` | 获取单个网页的内容，去除 HTML 标签后返回可读文本。支持自定义 UA 和超时。 |
| `crawl_site` | 从起始 URL 开始 BFS 爬取，沿同域名链接探索指定深度。可限制页面数，支持 URL 正则过滤。 |
| `extract_links` | 从指定网页提取所有链接，按站内/站外分类返回。 |
| `search_web` | 使用必应 (Bing) 免费搜索网页（无需 API Key），返回标题、URL 和摘要。 |
| `web-crawler-prompt-get` | 获取本技能的说明文档（SKILL.md）。 |

### 使用流程建议

```
1. 搜索信息       → search_web(query="关键词", max_results=5)
2. 获取单页内容   → fetch_page(url="https://...")
3. 提取页面链接   → extract_links(url="https://...")
4. 爬取整个站点   → crawl_site(url="https://...", max_depth=2, max_pages=10)
```

### 与 Tavily 对比

| 场景 | Tavily | web-crawler |
|------|--------|-------------|
| 搜索 | 需 API Key，结果结构化 | 必应免费搜索，无需 Key |
| 提取单页 | tavily_extract | fetch_page |
| 爬取站点 | tavily_crawl (API 驱动) | crawl_site (自主 BFS) |
| 地图 | tavily_map | extract_links |
| 深度研究 | tavily_research | 组合使用 fetch_page + crawl_site |

### 注意事项

- 所有工具使用 Node.js 内置 `fetch`，不依赖第三方 HTTP 库。
- `crawl_site` 默认仅爬取同域名页面，不会跨站。
- `search_web` 基于必应搜索，如搜索结果异常请检查网络连通性。
- 部分中文网站使用 GBK/GB2312 编码时可能出现乱码，建议优先抓取 UTF-8 站点。
- 爬取频率过快可能被目标网站限流，建议合理设置爬取深度和页面数。
