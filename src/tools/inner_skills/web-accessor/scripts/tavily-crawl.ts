import { tool } from 'ai';
import { z } from 'zod';

const TAVILY_API_BASE = 'https://api.tavily.com';

function getApiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('环境变量 TAVILY_API_KEY 未设置');
  return key;
}

function splitPaths(val?: string): string[] | undefined {
  if (!val) return undefined;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

export const tavilyCrawl = tool({
  description: `基于图的网站遍历工具，可并行探索多个路径，内置提取和智能发现`,
  inputSchema: z.object({
    url: z.string().describe('开始爬取的根 URL'),
    instructions: z.string().optional().describe('爬取的自然语言指令'),
    max_depth: z.number().min(1).max(5).optional().default(1).describe('最大爬取深度，1-5'),
    max_breadth: z.number().min(1).max(500).optional().default(20).describe('每层最大链接数，1-500'),
    limit: z.number().min(1).optional().default(50).describe('爬取的最大链接总数'),
    select_paths: z.string().optional().describe('只选择匹配这些正则路径模式的 URL（逗号分隔）'),
    exclude_paths: z.string().optional().describe('排除匹配这些正则路径模式的 URL（逗号分隔）'),
    extract_depth: z.enum(['basic', 'advanced']).optional().default('basic').describe('提取深度: basic 或 advanced'),
    format: z.enum(['markdown', 'text']).optional().default('markdown').describe('输出格式: markdown 或 text'),
    include_favicon: z.boolean().optional().describe('是否包含 favicon'),
    timeout: z.number().min(10).max(150).optional().describe('超时时间（秒），10-150'),
  }),
  execute: async ({ url, instructions, max_depth, max_breadth, limit, select_paths, exclude_paths, extract_depth, format, include_favicon, timeout }): Promise<string> => {
    try {
      const apiKey = getApiKey();
      const body: Record<string, unknown> = {
        url,
        max_depth: max_depth ?? 1,
        max_breadth: max_breadth ?? 20,
        limit: limit ?? 50,
        extract_depth: extract_depth ?? 'basic',
        format: format ?? 'markdown',
      };
      if (instructions) body.instructions = instructions;
      if (include_favicon !== undefined) body.include_favicon = include_favicon;
      if (timeout !== undefined) body.timeout = timeout;

      const selected = splitPaths(select_paths);
      if (selected && selected.length > 0) body.select_paths = selected;
      const excluded = splitPaths(exclude_paths);
      if (excluded && excluded.length > 0) body.exclude_paths = excluded;

      const res = await fetch(`${TAVILY_API_BASE}/crawl`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return `爬取请求失败 [${res.status}]: ${errText || res.statusText}`;
      }

      const data = await res.json();
      return JSON.stringify(data, null, 2);
    } catch (error) {
      return `tavily_crawl 执行出错: ${(error as Error).message}`;
    }
  },
});
