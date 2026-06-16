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

export const tavilyResearch = tool({
  description: `对给定主题进行全面研究，执行多次搜索、分析来源，生成详细研究报告`,
  inputSchema: z.object({
    input: z.string().describe('研究任务或问题'),
    model: z.enum(['mini', 'pro', 'auto']).optional().default('auto').describe('研究模型: mini（高效精准）、pro（全面多角度）、auto（自动选择）'),
    output_schema: z.string().optional().describe('JSON Schema 字符串，定义输出结构（将自动解析为对象）'),
    citation_format: z.enum(['numbered', 'mla', 'apa', 'chicago']).optional().describe('引用格式: numbered、mla、apa、chicago'),
    include_domains: z.string().optional().describe('优先考虑的域名（逗号分隔，最多20个）'),
    exclude_domains: z.string().optional().describe('排除的域名（逗号分隔，最多20个）'),
    output_length: z.enum(['short', 'standard', 'long']).optional().default('standard').describe('输出长度: short、standard、long'),
  }),
  execute: async ({ input, model, output_schema, citation_format, include_domains, exclude_domains, output_length }): Promise<string> => {
    try {
      const apiKey = getApiKey();
      const body: Record<string, unknown> = {
        input,
        model: model ?? 'auto',
        output_length: output_length ?? 'standard',
      };
      if (output_schema) {
        try {
          body.output_schema = JSON.parse(output_schema);
        } catch {
          return `错误: output_schema 不是有效的 JSON 字符串`;
        }
      }
      if (citation_format) body.citation_format = citation_format;

      const included = splitDomains(include_domains);
      if (included && included.length > 0) body.include_domains = included;
      const excluded = splitDomains(exclude_domains);
      if (excluded && excluded.length > 0) body.exclude_domains = excluded;

      const res = await fetch(`${TAVILY_API_BASE}/research`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return `研究请求失败 [${res.status}]: ${errText || res.statusText}`;
      }

      const data = await res.json();
      return JSON.stringify(data, null, 2);
    } catch (error) {
      return `tavily_research 执行出错: ${(error as Error).message}`;
    }
  },
});
