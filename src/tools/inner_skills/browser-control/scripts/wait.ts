import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserWait = tool({
  description: `等待页面中的元素出现/可见/隐藏，常用于等待异步加载的内容（如点击后等待弹窗、列表刷新）。`,
  inputSchema: z.object({
    selector: z.string().describe('要等待的选择器，如 "#loading-done"、"text=加载完成"'),
    state: z.enum(['visible', 'attached', 'hidden']).optional().default('visible').describe('等待的状态，默认 visible'),
    timeout: z.number().optional().default(10000).describe('超时时间（毫秒），默认 10000'),
  }),
  execute: async ({ selector, state, timeout }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      await page.waitForSelector(selector, { state, timeout });
      return `✅ 元素已${state}: ${selector}`;
    } catch (error) {
      return `❌ 等待失败: ${(error as Error).message}`;
    }
  },
});
