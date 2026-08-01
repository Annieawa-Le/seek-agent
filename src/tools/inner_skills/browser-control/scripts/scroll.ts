import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserScroll = tool({
  description: `滚动页面：按方向滚动（up/down/top/bottom）、按像素滚动，或滚动到指定元素。`,
  inputSchema: z.object({
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional().default('down').describe('滚动方向，默认 down'),
    amount: z.number().optional().default(500).describe('滚动像素数（仅 direction 为 up/down 时生效），默认 500'),
    selector: z.string().optional().describe('滚动到指定元素（提供时忽略 direction/amount）'),
  }),
  execute: async ({ direction, amount, selector }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      if (selector) {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 10000 });
        await locator.scrollIntoViewIfNeeded();
        return `✅ 已滚动到元素: ${selector}`;
      }
      await page.evaluate(({ dir, amt }) => {
        const w = globalThis as any;
        if (dir === 'top') {
          w.scrollTo(0, 0);
        } else if (dir === 'bottom') {
          // 兼容 body 与 documentElement 两种滚动容器（部分页面 body 高度为 0）
          const maxY = Math.max(
            w.document.body ? w.document.body.scrollHeight : 0,
            w.document.documentElement ? w.document.documentElement.scrollHeight : 0
          );
          w.scrollTo(0, maxY);
        } else {
          w.scrollBy(0, dir === 'up' ? -amt : amt);
        }
      }, { dir: direction, amt: amount });
      // 兼容读取滚动位置（window.scrollY 与 documentElement.scrollTop 等价，取较大值）
      const pos = await page.evaluate(() => {
        const w = globalThis as any;
        const y = Math.max(
          w.scrollY || 0,
          w.document && w.document.documentElement ? w.document.documentElement.scrollTop || 0 : 0
        );
        return { x: w.scrollX || 0, y };
      });
      const label = direction === 'top' ? '顶部' : direction === 'bottom' ? '底部' : `${direction} ${amount}px`;
      return `✅ 已滚动到${label}，当前位置 x=${pos.x} y=${pos.y}`;
    } catch (error) {
      return `❌ 滚动失败: ${(error as Error).message}`;
    }
  },
});

