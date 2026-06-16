import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../../workdir.js';
import { PDFParse } from 'pdf-parse';

export const pdfInfo = tool({
  description: '获取PDF文件的基本信息，包括页数、标题、作者、创建程序等元数据。',
  inputSchema: z.object({
    filePath: z.string().describe('PDF文件的路径（绝对路径或相对当前工作目录的路径）'),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const buffer = await fs.readFile(resolvePath(filePath));
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const infoResult = await parser.getInfo({ parsePageInfo: true });

        const lines: string[] = [];
        lines.push(`总页数: ${infoResult.total}`);

        if (infoResult.info) {
          const info = infoResult.info;
          if (info.Title) lines.push(`标题: ${info.Title}`);
          if (info.Author) lines.push(`作者: ${info.Author}`);
          if (info.Subject) lines.push(`主题: ${info.Subject}`);
          if (info.Keywords) lines.push(`关键词: ${info.Keywords}`);
          if (info.Creator) lines.push(`创建程序: ${info.Creator}`);
          if (info.Producer) lines.push(`生成程序: ${info.Producer}`);
          if (info.CreationDate) lines.push(`创建日期: ${info.CreationDate}`);
          if (info.ModDate) lines.push(`修改日期: ${info.ModDate}`);
        }

        if (infoResult.metadata) {
          const metaStr = infoResult.metadata.toString();
          if (metaStr) lines.push(`元数据: ${metaStr}`);
        }

        if (infoResult.outline && infoResult.outline.length > 0) {
          const count = infoResult.outline.length;
          lines.push(`书签/大纲条目数: ${count}`);
        }

        if (infoResult.pages && infoResult.pages.length > 0) {
          const hasLinks = infoResult.pages.some(p => p.links && p.links.length > 0);
          if (hasLinks) {
            const totalLinks = infoResult.pages.reduce((sum, p) => sum + (p.links?.length ?? 0), 0);
            lines.push(`超链接总数: ${totalLinks}`);
          }
        }

        return lines.join('\n');
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      return `获取PDF信息失败: ${(error as Error).message}`;
    }
  },
});




