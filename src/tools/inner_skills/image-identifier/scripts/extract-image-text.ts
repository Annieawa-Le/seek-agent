import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import fs from 'fs/promises';

// 动态导入 tesseract.js（避免冷启动时阻塞）
let tesseractModule: any = null;
async function getTesseract(): Promise<any> {
  if (!tesseractModule) {
    tesseractModule = await import('tesseract.js');
  }
  return tesseractModule;
}

export const extractImageText = tool({
  description: `使用 OCR 提取图片中嵌入的文字内容。支持中英文混合识别。返回提取到的文本及其在图片中的位置信息。`,
  inputSchema: z.object({
    filePath: z.string().describe('图片文件的路径（绝对路径或相对当前工作目录的路径）'),
    language: z.string().describe('OCR 识别语言，如 "chi_sim+eng"（中英文混合）、"eng"（仅英文）、"chi_sim"（仅中文），默认 chi_sim+eng').optional().default('chi_sim+eng'),
  }),
  execute: async ({ filePath, language = 'chi_sim+eng' }): Promise<string> => {
    try {
      const resolvedPath = path.resolve(filePath);

      // 检查文件是否存在
      try {
        await fs.stat(resolvedPath);
      } catch {
        return `错误: 文件不存在 - ${resolvedPath}`;
      }

      const { createWorker } = await getTesseract();

      const worker = await createWorker(language);

      try {
        const { data } = await worker.recognize(resolvedPath);

        const text = data.text?.trim();
        if (!text) {
          await worker.terminate();
          return 'OCR 未识别到文字（图片中可能不包含可识别文本）。';
        }

        // 提取词级别位置信息摘要
        const words = data.words || [];
        const lineCount = data.lines?.length || 0;
        const avgConfidence = words.length > 0
          ? (words.reduce((sum: number, w: any) => sum + (w.confidence || 0), 0) / words.length).toFixed(1)
          : 'N/A';

        const resultLines: string[] = [
          `识别语言: ${language}`,
          `识别文本长度: ${text.length} 字符`,
          `识别行数: ${lineCount}`,
          `词数: ${words.length}`,
          `平均置信度: ${avgConfidence}%`,
          '',
          '--- 识别结果 ---',
          text,
        ];

        // 如果置信度较低，附加提示
        if (words.length > 0 && parseFloat(avgConfidence as string) < 60) {
          resultLines.push('', '⚠ 识别置信度较低，结果可能不准确。可尝试调整语言参数或使用更高清图片。');
        }

        await worker.terminate();
        return resultLines.join('\n');
      } catch (ocrError: any) {
        await worker.terminate();
        return `OCR 识别失败: ${ocrError.message}`;
      }
    } catch (error: any) {
      return `执行错误: ${error.message}`;
    }
  },
});
