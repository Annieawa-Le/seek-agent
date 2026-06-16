## 用途

提供网页访问和搜索能力，基于 Tavily API。支持搜索引擎查询、网页内容提取、网站遍历爬取、网站地图生成和深度研究。

### 可用工具

| 工具 | 功能 |
|------|------|
| `tavily_search` | 使用 Tavily 搜索互联网，返回结构化的搜索结果和可选的 LLM 生成答案。支持 news/finance 主题过滤、时间范围筛选和域名白/黑名单。 |
| `tavily_extract` | 从一个或多个指定 URL 提取网页正文内容。支持 basic/advanced 两种提取深度，可返回 markdown 或纯文本格式。 |
| `tavily_crawl` | 基于图的网站遍历工具，从根 URL 开始沿链接探索，内置智能提取。可控制深度、广度、路径模式过滤。 |
| `tavily_map` | 网站地图生成工具，遍历网站结构返回所有发现的 URL 列表。 |
| `tavily_research` | 深度研究工具，对给定主题执行多次搜索、交叉分析来源，生成结构化研究报告。 |

### 使用流程建议

```
1. 快速查信息 → tavily_search(query, max_results=5, include_answer=true)
2. 看具体页面 → tavily_extract(urls="https://...")
3. 了解网站结构 → tavily_map(url="example.com")
4. 深度爬取 → tavily_crawl(url="example.com", max_depth=2, instructions="...")
5. 全面研究 → tavily_research(input="...", model="pro", output_length="long")
```

### 环境变量

- **TAVILY_API_KEY**（必需）— Tavily API 密钥，从 [Tavily Dashboard](https://app.tavily.ai) 获取。
  设置方式：`export TAVILY_API_KEY=tvly-YOUR_API_KEY`

### 注意事项

- 所有工具均通过 `TAVILY_API_KEY` 环境变量进行认证，使用前必须先设置。
- 参数中的域名列表（`include_domains` / `exclude_domains`）和路径列表（`select_paths` / `exclude_paths`）使用逗号分隔传入。
- `output_schema` 参数需传入一个合法的 JSON Schema 字符串，工具会自动解析为对象。
- Tavily API 基于信用点数（credits）计费，不同参数组合消耗不同。详见 [Tavily 定价文档](https://docs.tavily.com/documentation/api-credits)。
- 各 API 的详细参数说明可参阅 `references/` 目录下的 PDF 文档。

