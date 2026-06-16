import { tool } from 'ai';
import { z } from 'zod';
import { fetchHtml } from './utils';

/**
 * 解析 Bing 搜索结果 HTML。
 * Bing 搜索结果格式：<li class="b_algo"> 包含 <h2><a href="...">标题</a></h2> 和 <p>摘要</p>
 */
function parseBingResults(html: string): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];

  // 匹配 <li class="b_algo"> ... </li> 块
  const algoRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = algoRegex.exec(html)) !== null) {
    const block = match[1];

    // 提取 <h2> 中的链接和标题
    const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = linkMatch[1].trim();
    const title = linkMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    // 跳过不是真实网页的链接（如 javascript:）
    if (!url || url.startsWith('javascript:') || url === '#') continue;
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;

    // 提取摘要（在 <p> 标签中）
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    results.push({ title, url, snippet });
  }

  return results;
}

export const searchWeb = tool({
  description: `使用必应 (Bing) 免费搜索网页（无需 API Key），返回标题、URL 和摘要。适合快速查找公开信息。`,
  inputSchema: z.object({
    query: z.string().describe('搜索关键词'),
    max_results: z.number().optional().default(5).describe('返回结果数，1-20，默认 5'),
  }),
  execute: async ({ query, max_results }): Promise<string> => {
    const limit = Math.min(Math.max(max_results ?? 5, 1), 20);

    try {
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}`;
      const { html } = await fetchHtml(searchUrl, 15000);

      const results = parseBingResults(html);

      if (results.length === 0) {
        return `搜索 "${query}" 未找到结果。`;
      }

      const display = results.slice(0, limit);
      const lines: string[] = [];
      lines.push(`必应搜索结果: "${query}"`);
      lines.push(`共 ${results.length} 条结果，显示前 ${display.length} 条`);
      lines.push('');

      for (let i = 0; i < display.length; i++) {
        const r = display[i];
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   URL: ${r.url}`);
        if (r.snippet) {
          lines.push(`   ${r.snippet}`);
        }
        lines.push('');
      }

      return lines.join('\n');
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return `搜索请求超时，请稍后重试。`;
      }
      return `搜索失败: ${(error as Error).message}`;
    }
  }
});

