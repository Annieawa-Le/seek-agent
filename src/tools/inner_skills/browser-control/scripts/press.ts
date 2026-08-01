import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserPress = tool({
  description: `在页面上按下键盘按键（Enter、Tab、Escape、ArrowDown 等 Playwright key 名，组合键如 Control+A）。`,
  inputSchema: z.object({
    key: z.string().describe('按键名称，如 Enter、Tab、Escape、ArrowDown、Control+A'),
  }),
  execute: async ({ key }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      await page.keyboard.press(key);
      return `✅ 已按键: ${key}`;
    } catch (error) {
      return `❌ 按键失败: ${(error as Error).message}`;
    }
  },
});
