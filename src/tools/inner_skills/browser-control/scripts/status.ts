import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserStatus = tool({
  description: `查看当前浏览器状态：是否运行、运行方式、页面数、当前 URL 与页面标题。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const info = browserManager.getStatusInfo();
      if (!info.running) {
        return 'ℹ️ 浏览器未启动。请先调用 browser_launch 启动浏览器。';
      }
      const title = await browserManager.getTitle();
      return [
        `✅ 浏览器运行中`,
        `- 运行方式: ${info.channel}`,
        `- 无头模式: ${info.headless ? '是' : '否'}`,
        `- 页面数: ${info.pageCount}`,
        `- 当前 URL: ${info.url || '(无)'}`,
        `- 页面标题: ${title || '(无)'}`,
      ].join('\n');
    } catch (error) {
      return `❌ 查询状态失败: ${(error as Error).message}`;
    }
  },
});
