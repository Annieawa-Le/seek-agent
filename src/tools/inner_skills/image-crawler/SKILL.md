## 用途

网页图片资源爬取工具，支持从指定 URL 提取网页中嵌入的所有图片链接及其元信息（alt 文本、文件格式等），按条件筛选过滤图片，以及批量下载图片到本地目录。

### 可用工具

| 工具 | 功能 |
|------|------|
| `extract_images` | 从指定网页 URL 中提取所有图片资源，返回图片的完整 URL、alt 文本、文件扩展名等信息。支持设置图片最小尺寸过滤、只爬取特定格式等选项。自动处理懒加载属性（data-src）、srcset 响应式图片和 `<picture>` 元素。 |
| `filter_images` | 对已提取的图片列表进行二次筛选，支持按关键词匹配 alt 文本、按文件名模式过滤、按尺寸范围过滤。 |
| `download_images` | 将图片 URL 列表批量下载到本地指定目录。支持设置并发数、超时时间，自动生成文件名。返回每个文件的下载状态和本地路径。 |

### 典型使用流程

```
1. extract_images(url="https://example.com")  →  获取页面上所有图片
2. filter_images(images="...", formats="jpg,png", min_width=800)  →  筛选出大尺寸 jpg/png 图片
3. download_images(images="...", output_dir="./downloads", concurrency=5)  →  并发下载到本地
```

### 设计要点

- **extract_images** 会自动处理懒加载图片（data-src、data-original、data-lazy-src）、srcset 响应式图片集和 `<picture> <source>` 标签。
- 尺寸过滤依赖 HTML 标签中显式标注的 width/height 属性，未标注尺寸的图片在过滤时默认保留。
- **download_images** 支持传入纯 URL 字符串数组（如 `["https://..."]`）或带元信息的对象数组（如 `[{"url":"...","alt":"..."}]`）。
- 下载的文件名自动编号（image_001.jpg、image_002.png...），扩展名优先从 URL 推断，其次从 Content-Type 推断。
