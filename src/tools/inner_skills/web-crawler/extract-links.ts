import { tool } from 'ai';
import { z } from 'zod';
import { fetchHtml, extractHrefs, isSameDomain, extractBaseUrl } from './utils';

export const extractLinks = tool({
  description: `从指定网页中提取所有链接（href 属性），按站内/站外分类返回。`,
  inputSchema: z.object({
    url: z.string().describe('要提取链接的页面 URL'),
    timeout: z.number().optional().default(15000).describe('超时时间（毫秒），默认 15000'),
  }),
  execute: async ({ url, timeout }): Promise<string> => {
    try {
      new URL(url);

      const { html, finalUrl } = await fetchHtml(url, timeout ?? 15000);
      const baseUrl = extractBaseUrl(html, finalUrl);
      const allLinks = extractHrefs(html, baseUrl);

      // 去重并分类
      const internal: string[] = [];
      const external: string[] = [];
      const seen = new Set<string>();

      for (const link of allLinks) {
        if (seen.has(link)) continue;
        seen.add(link);
        if (isSameDomain(link, baseUrl)) {
          internal.push(link);
        } else {
          external.push(link);
        }
      }

      const lines: string[] = [];
      lines.push(`页面: ${finalUrl}`);
      lines.push(`共提取 ${allLinks.length} 个链接（去重后 ${seen.size} 个）`);
      lines.push('');

      lines.push(`--- 站内链接 (${internal.length}) ---`);
      if (internal.length === 0) {
        lines.push('  (无)');
      } else {
        for (const link of internal.slice(0, 100)) {
          lines.push(`  • ${link}`);
        }
        if (internal.length > 100) {
          lines.push(`  ... 及另外 ${internal.length - 100} 个站内链接`);
        }
      }

      lines.push('');
      lines.push(`--- 站外链接 (${external.length}) ---`);
      if (external.length === 0) {
        lines.push('  (无)');
      } else {
        for (const link of external.slice(0, 50)) {
          lines.push(`  • ${link}`);
        }
        if (external.length > 50) {
          lines.push(`  ... 及另外 ${external.length - 50} 个站外链接`);
        }
      }

      return lines.join('\n');
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return `请求超时: ${url}`;
      }
      return `提取链接失败: ${(error as Error).message}`;
    }
  },
});
