import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserLaunch = tool({
  description: `启动/获取浏览器实例（单例常驻）。使用真实浏览器（系统 Edge/Chrome）驱动页面，指纹真实抗反爬；浏览器实例在进程内保持，AI 可多轮持续操作同一页面。已启动时重复调用直接返回当前状态。`,
  inputSchema: z.object({
    headless: z.boolean().optional().default(false).describe('无头模式，默认 false（有头便于调试，服务器环境可设 true）'),
    channel: z.string().optional().default('msedge').describe('浏览器通道：msedge / chrome，默认 msedge'),
    viewport: z.object({ width: z.number(), height: z.number() }).optional().describe('视口尺寸，默认 1280x720'),
    userDataDir: z.string().optional().describe('持久化用户数据目录（保留登录态/Cookie），默认不持久化'),
  }),
  execute: async (args): Promise<string> => {
    try {
      const result = await browserManager.launch(args);
      return [
        `✅ 浏览器已就绪`,
        `- 运行方式: ${result.channel}`,
        `- 无头模式: ${result.headless ? '是' : '否'}`,
        `- 页面数: ${result.pages}`,
        result.pages === 0 ? `- 提示: 页面数为 0，请调用 browser_navigate 打开页面` : '',
      ].filter(Boolean).join('\n');
    } catch (error) {
      return `❌ 浏览器启动失败: ${(error as Error).message}`;
    }
  },
});
