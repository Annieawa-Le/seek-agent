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

export const tavilyMap = tool({
  description: `像图一样遍历网站，生成全面的网站地图（返回 URL 列表）`,
  inputSchema: z.object({
    url: z.string().describe('开始映射的根 URL'),
    instructions: z.string().optional().describe('映射的自然语言指令'),
    max_depth: z.number().min(1).max(5).optional().default(1).describe('最大映射深度，1-5'),
    max_breadth: z.number().min(1).max(500).optional().default(20).describe('每层最大链接数，1-500'),
    limit: z.number().min(1).optional().default(50).describe('映射的最大链接总数'),
    select_paths: z.string().optional().describe('只选择匹配这些正则路径模式的 URL（逗号分隔）'),
    exclude_paths: z.string().optional().describe('排除匹配这些正则路径模式的 URL（逗号分隔）'),
    include_usage: z.boolean().optional().describe('是否包含信用使用信息'),
    timeout: z.number().min(10).max(150).optional().describe('超时时间（秒），10-150'),
  }),
  execute: async ({ url, instructions, max_depth, max_breadth, limit, select_paths, exclude_paths, include_usage, timeout }): Promise<string> => {
    try {
      const apiKey = getApiKey();
      const body: Record<string, unknown> = {
        url,
        max_depth: max_depth ?? 1,
        max_breadth: max_breadth ?? 20,
        limit: limit ?? 50,
      };
      if (instructions) body.instructions = instructions;
      if (include_usage !== undefined) body.include_usage = include_usage;
      if (timeout !== undefined) body.timeout = timeout;

      const selected = splitPaths(select_paths);
      if (selected && selected.length > 0) body.select_paths = selected;
      const excluded = splitPaths(exclude_paths);
      if (excluded && excluded.length > 0) body.exclude_paths = excluded;

      const res = await fetch(`${TAVILY_API_BASE}/map`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return `映射请求失败 [${res.status}]: ${errText || res.statusText}`;
      }

      const data = await res.json();
      return JSON.stringify(data, null, 2);
    } catch (error) {
      return `tavily_map 执行出错: ${(error as Error).message}`;
    }
  },
});
