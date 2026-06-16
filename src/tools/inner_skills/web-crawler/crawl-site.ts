import { tool } from 'ai';
import { z } from 'zod';
import { fetchHtml, extractTitle, htmlToText, extractHrefs, isSameDomain, extractBaseUrl, truncateText } from './utils';

export const crawlSite = tool({
  description: `从起始 URL 开始 BFS 爬取，沿同域名链接探索指定深度。返回每个页面的标题、URL 和文本摘要。`,
  inputSchema: z.object({
    url: z.string().describe('起始爬取的 URL'),
    max_depth: z.number().optional().default(1).describe('最大爬取深度，1-3，默认 1'),
    max_pages: z.number().optional().default(10).describe('最大爬取页面数，1-50，默认 10'),
    include_pattern: z.string().optional().describe('只爬取 URL 匹配该正则表达式的页面（可选）'),
    exclude_pattern: z.string().optional().describe('排除 URL 匹配该正则表达式的页面（可选）'),
  }),
  execute: async ({ url, max_depth, max_pages, include_pattern, exclude_pattern }): Promise<string> => {
    const depth = Math.min(Math.max(max_depth ?? 1, 1), 3);
    const limit = Math.min(Math.max(max_pages ?? 10, 1), 50);

    let includeRe: RegExp | null = null;
    let excludeRe: RegExp | null = null;
    try {
      if (include_pattern) includeRe = new RegExp(include_pattern);
    } catch {
      return `include_pattern 正则表达式无效: ${include_pattern}`;
    }
    try {
      if (exclude_pattern) excludeRe = new RegExp(exclude_pattern);
    } catch {
      return `exclude_pattern 正则表达式无效: ${exclude_pattern}`;
    }

    try {
      new URL(url);
    } catch {
      return `URL 格式无效: ${url}`;
    }

    // BFS 爬取
    const visited = new Set<string>();
    const results: { url: string; title: string; summary: string; depth: number; error?: string }[] = [];
    const queue: { url: string; depth: number }[] = [{ url, depth: 0 }];

    while (queue.length > 0 && results.length < limit) {
      const current = queue.shift()!;

      if (visited.has(current.url)) continue;
      visited.add(current.url);

      // 检查 include/exclude
      if (includeRe && !includeRe.test(current.url)) continue;
      if (excludeRe && excludeRe.test(current.url)) continue;

      try {
        const { html, finalUrl } = await fetchHtml(current.url, 10000);
        const title = extractTitle(html);
        const text = htmlToText(html);
        const summary = truncateText(text, 2000);

        results.push({
          url: finalUrl,
          title: title || '(无标题)',
          summary,
          depth: current.depth,
        });

        // 如果还没到最大深度，把同域名下的链接加入队列
        if (current.depth < depth && results.length < limit) {
          const baseUrl = extractBaseUrl(html, finalUrl);
          const links = extractHrefs(html, baseUrl);
          const domainLinks = links.filter(l => isSameDomain(l, finalUrl));

          for (const link of domainLinks) {
            if (!visited.has(link) && !queue.some(q => q.url === link)) {
              queue.push({ url: link, depth: current.depth + 1 });
            }
          }
        }
      } catch (error) {
        results.push({
          url: current.url,
          title: '(访问失败)',
          summary: (error as Error).message,
          depth: current.depth,
          error: (error as Error).message,
        });
      }
    }

    // 整理输出
    const lines: string[] = [];
    lines.push(`爬取报告`);
    lines.push(`起始URL: ${url}`);
    lines.push(`设置深度: ${depth}，实际爬取: ${results.length} 页`);
    lines.push('');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`[${i + 1}/${results.length}] ${r.title}`);
      lines.push(`    深度: ${r.depth}  URL: ${r.url}`);
      if (r.error) {
        lines.push(`    错误: ${r.error}`);
      } else {
        // 取摘要前几行
        const snippetLines = r.summary.split('\n').filter(Boolean).slice(0, 5);
        for (const sl of snippetLines) {
          if (sl.length > 120) {
            lines.push(`    ${sl.slice(0, 120)}...`);
          } else {
            lines.push(`    ${sl}`);
          }
        }
      }
      lines.push('');
    }

    if (queue.length > 0 && results.length >= limit) {
      lines.push(`(已达最大页面数 ${limit}，队列中还有 ${queue.length} 个未爬取链接)`);
    }

    return lines.join('\n');
  },
});
