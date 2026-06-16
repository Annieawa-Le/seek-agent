## 用途

提供PDF文件的文字读取、图片提取和元信息获取能力。基于 pdf-parse（pdfjs-dist）引擎，支持读取整个文档、指定页码范围、提取嵌入图片以及获取文档基本信息。

### 可用工具

| 工具 | 功能 |
|------|------|
| `read_pdf` | 读取整个PDF文件，提取所有文字内容为纯文本输出。 |
| `read_pdf_pages` | 读取PDF文件中指定页码范围的内容，提取文字为纯文本输出。 |
| `pdf_info` | 获取PDF文件的基本信息，包括页数、标题、作者、创建程序等元数据。 |
| `pdf_extract_images` | 提取PDF文件中嵌入的图片，返回每页的图片元信息（位置、尺寸、类型），可选返回 base64 数据。 |
| `pdf-reader-prompt-get` | 获取本技能的说明文档（SKILL.md）。 |

### 使用流程建议

```
1. pdf_info(filePath)  → 了解文档概览（页数、作者等）
2. read_pdf(filePath)   → 提取全文文字
3. read_pdf_pages(filePath, startPage, endPage)  → 读取特定页码范围
4. pdf_extract_images(filePath, imageDataUrl?)  → 提取嵌入图片
5. 对于超长PDF，先用 pdf_info 获取总页数，再分段读取
```

### 注意事项

- 所有文件路径支持绝对路径或相对当前工作目录的路径。
- `pdf_extract_images` 默认只返回图片元信息（尺寸、类型），设置 `imageDataUrl: true` 可获取 base64 数据。
- 图片提取会跳过过小的装饰性图片，可通过 `imageThreshold` 调整阈值。
- 提取文字时自动添加分页标记 `--- 第 N 页 / 共 M 页 ---`。

