import { tool } from 'ai';
import { z } from 'zod';

const TAVILY_API_BASE = 'https://api.tavily.com';

function getApiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('环境变量 TAVILY_API_KEY 未设置');
  return key;
}

export const tavilyExtract = tool({
  description: `从一个或多个指定 URL 提取网页内容`,
  inputSchema: z.object({
    urls: z.string().describe('要提取内容的 URL，多个以逗号分隔'),
    extract_depth: z.enum(['basic', 'advanced']).optional().default('basic').describe('提取深度: basic（基础）或 advanced（高级，包含表格等）'),
    include_images: z.boolean().optional().describe('是否包含图片列表'),
    format: z.enum(['markdown', 'text']).optional().default('markdown').describe('输出格式: markdown 或 text'),
    query: z.string().optional().describe('用于对提取内容进行重排序的用户意图'),
    chunks_per_source: z.number().min(1).max(5).optional().describe('每个源返回的片段数，1-5（仅 query 提供时可用）'),
    timeout: z.number().min(1).max(60).optional().describe('超时时间（秒），1-60'),
  }),
  execute: async ({ urls, extract_depth, include_images, format, query, chunks_per_source, timeout }): Promise<string> => {
    try {
      const apiKey = getApiKey();
      const urlList = urls.split(',').map(s => s.trim()).filter(Boolean);
      if (urlList.length === 0) return '错误: 至少需要提供一个有效的 URL';

      const body: Record<string, unknown> = {
        urls: urlList,
        extract_depth: extract_depth ?? 'basic',
        format: format ?? 'markdown',
      };
      if (include_images !== undefined) body.include_images = include_images;
      if (query) body.query = query;
      if (chunks_per_source !== undefined) body.chunks_per_source = chunks_per_source;
      if (timeout !== undefined) body.timeout = timeout;

      const res = await fetch(`${TAVILY_API_BASE}/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return `提取请求失败 [${res.status}]: ${errText || res.statusText}`;
      }

      const data = await res.json();
      return JSON.stringify(data, null, 2);
    } catch (error) {
      return `tavily_extract 执行出错: ${(error as Error).message}`;
    }
  },
});
