import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserClick = tool({
  description: `点击页面中的元素。支持 CSS 选择器、text=、role= 等 Playwright 选择器语法。`,
  inputSchema: z.object({
    selector: z.string().describe('目标元素选择器，如 "button.submit"、"text=登录"、"role=button[name=确定]"'),
    timeout: z.number().optional().default(10000).describe('等待元素超时（毫秒），默认 10000'),
  }),
  execute: async ({ selector, timeout }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout });
      const tag = await locator.evaluate((el) => {
        const e = el as any;
        return e.tagName.toLowerCase() + (e.textContent ? ` "${e.textContent.trim().slice(0, 30)}"` : '');
      }).catch(() => selector);
      await locator.click({ timeout });
      return `✅ 已点击元素: ${selector} (${tag})`;
    } catch (error) {
      return `❌ 点击失败: ${(error as Error).message}`;
    }
  },
});


