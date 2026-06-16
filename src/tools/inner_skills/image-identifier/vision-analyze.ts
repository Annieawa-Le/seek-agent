import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

/** 文件扩展名 → MIME 类型映射 */
function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return mimeMap[ext.toLowerCase()] || 'image/png';
}

/** OpenAI 兼容的 Chat Completions 响应结构 */
interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
    };
  }[];
}

export const visionAnalyze = tool({
  description: `将图片发送给多模态视觉模型进行分析识别。从 .env 读取 IMAGE_BASE_URL、IMAGE_API_KEY、IMAGE_MODEL 配置，以 OpenAI 兼容格式调用视觉模型 API（支持标准 image_url 传图）。适用于 Qwen-VL 系列等兼容 OpenAI 接口的模型。`,
  inputSchema: z.object({
    filePath: z.string().describe('图片文件的路径（绝对路径或相对当前工作目录的路径）'),
    prompt: z.string().describe('向视觉模型提出的问题或指令，如"这张图中包含什么文字？"或"请描述这张图片的内容"').optional().default('请详细描述这张图片中的内容。'),
  }),
  execute: async ({ filePath, prompt = '请详细描述这张图片中的内容。' }): Promise<string> => {
    const baseUrl = process.env.IMAGE_BASE_URL || '';
    const apiKey = process.env.IMAGE_API_KEY || process.env.DASHSCOPE_API_KEY || '';
    const modelName = process.env.IMAGE_MODEL || 'qwen-vl-plus';

    if (!baseUrl || !apiKey) {
      return '错误: 未配置视觉模型 API。请在 .env 中设置 IMAGE_BASE_URL 和 IMAGE_API_KEY（或 DASHSCOPE_API_KEY）。';
    }

    try {
      const resolvedPath = path.resolve(filePath);

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        return `错误: 文件不存在 - ${resolvedPath}`;
      }

      if (stat.size > 20 * 1024 * 1024) {
        return '错误: 图片超过 20MB 大小限制，请压缩后重试。';
      }

      const imageBuffer = await fs.readFile(resolvedPath);
      const ext = path.extname(resolvedPath);
      const mimeType = getMimeType(ext);
      const base64Image = imageBuffer.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64Image}`;

      const apiUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 2048,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return `API 请求失败 (${response.status}): ${errorText}`;
      }

      const result = (await response.json()) as ChatCompletionResponse;
      const content = result.choices?.[0]?.message?.content;

      if (!content) {
        return '模型返回为空。可能原因：图片格式不被支持、模型无法处理该请求、或 token 限制。';
      }

      return content;
    } catch (error: any) {
      return `执行错误: ${error.message}`;
    }
  },
});
