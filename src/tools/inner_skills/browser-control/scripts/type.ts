import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserType = tool({
  description: `向页面中的输入框输入文本。默认先清空原有内容再输入。`,
  inputSchema: z.object({
    selector: z.string().describe('输入框选择器，如 "#username"、"input[name=password]"'),
    text: z.string().describe('要输入的文本内容'),
    clear: z.boolean().optional().default(true).describe('输入前是否清空原有内容，默认 true'),
    delay: z.number().optional().default(0).describe('按键间隔（毫秒），模拟真人输入速度，默认 0'),
  }),
  execute: async ({ selector, text, clear, delay }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      if (clear) {
        await locator.fill('');
      }
      await locator.type(text, { delay });
      return `✅ 已向 ${selector} 输入 ${text.length} 个字符${clear ? '（已清空原内容）' : ''}`;
    } catch (error) {
      return `❌ 输入失败: ${(error as Error).message}`;
    }
  },
});
