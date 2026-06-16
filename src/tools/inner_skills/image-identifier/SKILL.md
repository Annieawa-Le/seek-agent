## 用途

用于读取图片文件，提取图片元信息（格式、尺寸、色彩模式、文件大小等）、通过 OCR 提取图片中嵌入的文字，以及通过多模态视觉模型识别图片内容。

### 可用工具

| 工具 | 功能 | 适用场景 |
|------|------|---------|
| `image_info` | 读取单张图片的格式、尺寸（宽高）、色彩模式、文件大小 | 确认图片基本信息、验证文件有效性 |
| `extract_image_text` | 使用 OCR 提取图片中嵌入的文字，支持中英文混合识别，返回置信度 | 截图/文档/表单中的文字提取、印刷体识别 |
| `vision_analyze` | 调用多模态视觉模型（OpenAI 兼容格式）分析图片语义 | 自然场景理解、物体识别、图片描述、对 OCR 结果的二次确认 |

### 环境变量配置（vision_analyze）

```env
IMAGE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
IMAGE_API_KEY=sk-xxx
IMAGE_MODEL=qwen-vl-plus
```

也兼容 `DASHSCOPE_API_KEY` 作为 API Key。

### 推荐工作流

1. 调用 `image_info` 确认图片路径有效、格式支持、大小合适
2. 根据用户意图选择：
   - 要**读文字** → `extract_image_text`
   - 要**理解内容** → `vision_analyze`
3. 如果 `extract_image_text` 返回空或置信度过低，可补调 `vision_analyze` 做二次确认

### 注意事项

- `extract_image_text` 首次调用时自动下载语言数据（约 10-15MB），有短暂延迟，后续从缓存加载
- 中英文混合默认 `chi_sim+eng`；仅英文可指定 `eng` 提速
- `vision_analyze` 的图片超过 20MB 会失败
- 视觉模型回答可能有幻觉，质疑性使用
- 路径支持 Windows 和 Unix 风格
