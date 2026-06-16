import { tool } from 'ai';
import { z } from 'zod';
import { fetchHtml, extractTitle, htmlToText, truncateText } from './utils';

export const fetchPage = tool({
  description: `获取单个网页的内容，去除 HTML 标签后返回可读文本。支持自定义 User-Agent、超时时间。`,
  inputSchema: z.object({
    url: z.string().describe('要获取的网页 URL（完整 URL，如 https://example.com/page）'),
    timeout: z.number().optional().default(15000).describe('超时时间（毫秒），默认 15000'),
    user_agent: z.string().optional().describe('自定义 User-Agent，默认使用 Chrome 标准 UA'),
  }),
  execute: async ({ url, timeout, user_agent }): Promise<string> => {
    try {
      new URL(url); // 提前校验 URL 格式

      const { html, finalUrl } = await fetchHtml(url, timeout ?? 15000, user_agent);
      const title = extractTitle(html);
      const text = htmlToText(html);

      const result = [
        `标题: ${title || '(无标题)'}`,
        finalUrl !== url ? `实际URL: ${finalUrl}` : '',
        `内容长度: ${text.length} 字符`,
        '',
        '--- 正文开始 ---',
        '',
        truncateText(text, 50000),
      ]
        .filter(Boolean)
        .join('\n');

      return result;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return `请求超时: ${url}`;
      }
      return `获取页面失败: ${(error as Error).message}`;
    }
  },
});
