## image-identifier 使用指引

调用 `image_info` 或 `extract_image_text` 前确认文件路径有效。`vision_analyze` 的 prompt 根据用户实际需求定制，不要使用默认值。OCR 结果置信度过低时，如果你可以还原文本意思，且并非非常重要，可不用补调 `vision_analyze` 二次确认。视觉模型回答可能有幻觉，质疑性使用。
