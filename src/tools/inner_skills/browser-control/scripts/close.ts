import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserClose = tool({
  description: `关闭浏览器实例并释放资源。浏览器实例常驻进程内，使用完毕后应调用本工具释放（否则占用内存）。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      if (!browserManager.isRunning) {
        return 'ℹ️ 浏览器未启动，无需关闭。';
      }
      await browserManager.close();
      return '✅ 浏览器已关闭，实例已释放。';
    } catch (error) {
      return `❌ 关闭失败: ${(error as Error).message}`;
    }
  },
});
