import { tool } from 'ai';
import { z } from 'zod';

const TAVILY_API_BASE = 'https://api.tavily.com';

function getApiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('环境变量 TAVILY_API_KEY 未设置');
  return key;
}

function splitDomains(val?: string): string[] | undefined {
  if (!val) return undefined;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

export const tavilySearch = tool({
  description: `使用 Tavily 搜索互联网，返回搜索结果和可选 LLM 生成的答案`,
  inputSchema: z.object({
    query: z.string().describe('搜索查询语句'),
    search_depth: z.enum(['basic', 'advanced', 'fast', 'ultra-fast']).optional().default('basic').describe('搜索深度: basic（平衡）、advanced（高精准）、fast（低延迟）、ultra-fast（最低延迟）'),
    topic: z.enum(['general', 'news', 'finance']).optional().default('general').describe('搜索主题: general（通用）、news（新闻）、finance（财经）'),
    max_results: z.number().min(0).max(20).optional().default(5).describe('返回的最大结果数，0-20'),
    include_answer: z.union([z.boolean(), z.enum(['basic', 'advanced'])]).optional().describe('是否包含 LLM 生成的答案， true/basic 返回简短答案，advanced 返回详细答案'),
    include_raw_content: z.union([z.boolean(), z.enum(['markdown', 'text'])]).optional().describe('是否包含 cleaned HTML 原始内容，true/markdown 返回 markdown，text 返回纯文本'),
    include_domains: z.string().optional().describe('只包含这些域名的结果（逗号分隔，最多300个）'),
    exclude_domains: z.string().optional().describe('排除这些域名的结果（逗号分隔，最多150个）'),
    time_range: z.enum(['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y']).optional().describe('时间范围: day/week/month/year'),
    chunks_per_source: z.number().min(1).max(3).optional().describe('每个源返回的片段数，1-3（仅 advanced 深度可用）'),
  }),
  execute: async ({ query, search_depth, topic, max_results, include_answer, include_raw_content, include_domains, exclude_domains, time_range, chunks_per_source }): Promise<string> => {
    try {
      const apiKey = getApiKey();
      const body: Record<string, unknown> = {
        query,
        search_depth: search_depth ?? 'basic',
        topic: topic ?? 'general',
        max_results: max_results ?? 5,
      };
      if (include_answer !== undefined) body.include_answer = include_answer;
      if (include_raw_content !== undefined) body.include_raw_content = include_raw_content;
      if (time_range) body.time_range = time_range;
      if (chunks_per_source !== undefined) body.chunks_per_source = chunks_per_source;

      const domains = splitDomains(include_domains);
      if (domains && domains.length > 0) body.include_domains = domains;
      const excluded = splitDomains(exclude_domains);
      if (excluded && excluded.length > 0) body.exclude_domains = excluded;

      const res = await fetch(`${TAVILY_API_BASE}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return `搜索请求失败 [${res.status}]: ${errText || res.statusText}`;
      }

      const data = await res.json();
      return JSON.stringify(data, null, 2);
    } catch (error) {
      return `tavily_search 执行出错: ${(error as Error).message}`;
    }
  },
});
