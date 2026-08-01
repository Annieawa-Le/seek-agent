import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

const MAX_DEFAULT = 50000;

export const browserExtract = tool({
  description: `提取当前页面内容：文本 / HTML / 链接 / 元信息，支持限定选择器范围。`,
  inputSchema: z.object({
    mode: z.enum(['text', 'html', 'links', 'meta', 'all']).optional().default('text').describe('提取模式，默认 text'),
    selector: z.string().optional().describe('限定提取范围的选择器，默认提取整页'),
    maxLength: z.number().optional().default(MAX_DEFAULT).describe('内容最大长度，默认 50000'),
  }),
  execute: async ({ mode, selector, maxLength }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      const limit = maxLength ?? MAX_DEFAULT;
      const parts: string[] = [];

      if (mode === 'text' || mode === 'all') {
        const text = selector
          ? await page.locator(selector).first().innerText().catch(() => '(选择器未匹配到元素)')
          : await page.innerText('body').catch(() => '(无法提取文本)');
        parts.push(`--- 页面文本 ---\n${truncate(text, limit)}`);
      }
      if (mode === 'html' || mode === 'all') {
        const html = selector
          ? await page.locator(selector).first().innerHTML().catch(() => '(选择器未匹配到元素)')
          : await page.content();
        parts.push(`--- 页面 HTML ---\n${truncate(html, limit)}`);
      }
      if (mode === 'links' || mode === 'all') {
        const links = await page.$$eval('a[href]', (as) =>
          as
            .map((a) => ({
              text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
              href: (a as any).href,
            }))
            .filter((l) => l.href.startsWith('http'))
        ).catch(() => []);
        parts.push(`--- 链接 (共 ${links.length} 个) ---`);
        links.slice(0, 200).forEach((l, i) => parts.push(`${i + 1}. ${l.text || '(无文本)'} → ${l.href}`));
      }
      if (mode === 'meta' || mode === 'all') {
        const meta = await page.evaluate(() => {
          const w = globalThis as any;
          const doc = w.document;
          const desc = doc.querySelector('meta[name="description"]');
          return {
            title: doc.title,
            url: w.location.href,
            description: desc ? desc.getAttribute('content') || '' : '',
            lang: doc.documentElement.lang || '',
          };
        }).catch(() => ({ title: '', url: '', description: '', lang: '' }));
        parts.push(`--- 元信息 ---\n标题: ${meta.title || '(无)'}\nURL: ${meta.url || '(无)'}\n描述: ${meta.description || '(无)'}\n语言: ${meta.lang || '(无)'}`);
      }

      return parts.join('\n\n');
    } catch (error) {
      return `❌ 提取失败: ${(error as Error).message}`;
    }
  },
});

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n... [内容已截断，共 ' + s.length + ' 字符]';
}



