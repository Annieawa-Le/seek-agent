import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../workdir.js';
import { PDFParse } from 'pdf-parse';

export const readPdfPages = tool({
  description: '读取PDF文件中指定页码范围的内容，提取文字为纯文本输出。',
  inputSchema: z.object({
    filePath: z.string().describe('PDF文件的路径（绝对路径或相对当前工作目录的路径）'),
    startPage: z.number().describe('起始页码（从1开始）'),
    endPage: z.number().describe('结束页码（包含该页）'),
  }),
  execute: async ({ filePath, startPage, endPage }): Promise<string> => {
    try {
      const buffer = await fs.readFile(resolvePath(filePath));
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const textResult = await parser.getText({
          first: startPage,
          last: endPage,
          lineEnforce: true,
          parseHyperlinks: false,
          pageJoiner: '\n\n--- 第 page_number 页 / 共 total_number 页 ---\n\n',
        });
        return textResult.text;
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      return `读取PDF失败: ${(error as Error).message}`;
    }
  },
});




