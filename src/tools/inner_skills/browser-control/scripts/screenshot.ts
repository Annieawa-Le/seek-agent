import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { browserManager } from './manager';

export const browserScreenshot = tool({
  description: `截图当前页面（或指定元素），保存到工作区 browser-shots/ 目录，返回文件路径供视觉模型（vision_analyze）分析。`,
  inputSchema: z.object({
    path: z.string().optional().describe('自定义保存路径（相对工作区），默认自动生成 browser-shots/shot-{时间戳}.png'),
    fullPage: z.boolean().optional().default(false).describe('是否截取整页，默认 false（仅视口）'),
    selector: z.string().optional().describe('仅截取指定元素区域，默认截取整个视口'),
  }),
  execute: async ({ path: customPath, fullPage, selector }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      const shotPath = customPath || `browser-shots/shot-${Date.now()}.png`;
      const absPath = path.isAbsolute(shotPath) ? shotPath : path.join(process.cwd(), shotPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });

      if (selector) {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 10000 });
        await locator.screenshot({ path: absPath });
      } else {
        await page.screenshot({ path: absPath, fullPage: fullPage ?? false });
      }
      return `✅ 截图已保存: ${absPath}\n提示: 可调用 vision_analyze(filePath="${absPath}") 让视觉模型理解页面内容。`;
    } catch (error) {
      return `❌ 截图失败: ${(error as Error).message}`;
    }
  },
});
