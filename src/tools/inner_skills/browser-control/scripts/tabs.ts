import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserTabs = tool({
  description: `列出浏览器当前所有标签页（序号 / URL / 标题 / 是否焦点页），供 browser_switch_tab 切换焦点页。适合多标签页场景（如点击 target="_blank" 打开新页后查看所有页）。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const pages = await browserManager.listPages();
      if (pages.length === 0) {
        return 'ℹ️ 当前没有标签页。请先 browser_launch 启动浏览器并 browser_navigate 打开页面。';
      }
      const lines = pages.map((p) =>
        `${p.active ? '▶' : ' '} [${p.index}] ${p.title || '(无标题)'} — ${p.url}`
      );
      return `✅ 共 ${pages.length} 个标签页：\n${lines.join('\n')}\n提示: 用 browser_switch_tab(index=序号) 切换焦点页。`;
    } catch (error) {
      return `❌ 列出标签页失败: ${(error as Error).message}`;
    }
  },
});

export const browserSwitchTab = tool({
  description: `切换浏览器焦点到指定标签页（index 来自 browser_tabs 返回的序号）。切换后后续工具（navigate/click/extract/screenshot 等）都作用于新焦点页。`,
  inputSchema: z.object({
    index: z.number().int().min(0).describe('要切换到的标签页序号（从 0 开始）'),
  }),
  execute: async ({ index }): Promise<string> => {
    try {
      const p = await browserManager.switchPage(index);
      return [
        `✅ 已切换到标签页 [${p.index}]`,
        `- 标题: ${p.title || '(无标题)'}`,
        `- URL: ${p.url}`,
      ].join('\n');
    } catch (error) {
      return `❌ 切换失败: ${(error as Error).message}`;
    }
  },
});
