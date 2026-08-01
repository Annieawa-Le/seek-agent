import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserNavigate = tool({
  description: `在当前浏览器页面导航到指定 URL，返回页面标题与 HTTP 状态码。`,
  inputSchema: z.object({
    url: z.string().describe('要访问的完整 URL，如 https://example.com'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional().default('load').describe('等待加载完成的条件，默认 load'),
    timeout: z.number().optional().default(30000).describe('超时时间（毫秒），默认 30000'),
  }),
  execute: async ({ url, waitUntil, timeout }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      const response = await page.goto(url, { waitUntil, timeout });
      const status = response?.status() ?? 0;
      const title = await page.title().catch(() => '');
      const finalUrl = page.url();
      return [
        `✅ 已导航到 ${finalUrl}`,
        `- 页面标题: ${title || '(无标题)'}`,
        `- HTTP 状态: ${status}`,
      ].join('\n');
    } catch (error) {
      return `❌ 导航失败: ${(error as Error).message}`;
    }
  },
});
