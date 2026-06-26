import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import fs from 'fs/promises';
import { ocrManager } from './ocr-manager';

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

      // 通过独立子进程执行 OCR（避免 tesseract.js 的 worker_threads 被 tsx hook 干扰）
      const result = await ocrManager.recognize(resolvedPath, language);

      if (!result.ok) {
        return `OCR 识别失败: ${result.error}`;
      }

      const text = result.text?.trim();
      if (!text) {
        return 'OCR 未识别到文字（图片中可能不包含可识别文本）。';
      }

      const resultLines: string[] = [
        `识别语言: ${language}`,
        `识别文本长度: ${text.length} 字符`,
        `识别行数: ${result.lineCount}`,
        `词数: ${result.wordCount}`,
        `平均置信度: ${result.confidence}%`,
        '',
        '--- 识别结果 ---',
        text,
      ];

      // 如果置信度较低，附加提示
      if (parseFloat(result.confidence as string) < 60) {
        resultLines.push('', '⚠ 识别置信度较低，结果可能不准确。可尝试调整语言参数或使用更高清图片。');
      }

      return resultLines.join('\n');
    } catch (error: any) {
      // 子进程层面的错误（如超时、进程崩溃）
      return `OCR 执行错误: ${error.message}`;
    }
  },
});

