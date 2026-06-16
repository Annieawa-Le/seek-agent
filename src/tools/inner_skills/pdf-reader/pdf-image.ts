import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../workdir.js';
import { PDFParse } from 'pdf-parse';
import type { ImageResult, PageImages } from 'pdf-parse';

export const pdfExtractImages = tool({
  description: '提取PDF文件中嵌入的图片。返回每页的图片元信息（位置、尺寸、类型），可通过参数控制是否返回 base64 数据。',
  inputSchema: z.object({
    filePath: z.string().describe('PDF文件的路径（绝对路径或相对当前工作目录的路径）'),
    imageDataUrl: z.boolean().optional().describe('是否包含图片的 base64 数据（默认 false，只返回元信息）'),
    imageThreshold: z.number().optional().describe('最小图片尺寸（像素），小于此值的图片被忽略（默认 80）'),
  }),
  execute: async ({ filePath, imageDataUrl, imageThreshold }): Promise<string> => {
    try {
      const buffer = await fs.readFile(resolvePath(filePath));
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result: ImageResult = await parser.getImage({
          imageDataUrl: imageDataUrl ?? false,
          imageBuffer: false,
          imageThreshold: imageThreshold ?? 80,
        });

        const lines: string[] = [];
        lines.push(`共 ${result.total} 页，开始扫描嵌入图片...`);

        for (const page of result.pages) {
          const { pageNumber, images } = page;
          if (!images || images.length === 0) {
            lines.push(`第 ${pageNumber} 页: 无嵌入图片`);
          } else {
            lines.push(`第 ${pageNumber} 页: 共 ${images.length} 张图片`);
            for (let i = 0; i < images.length; i++) {
              const img = images[i];
              const dims = `${img.width}x${img.height}px`;
              const kindName = ImageKindLabel(img.kind);
              const hasData = imageDataUrl && img.dataUrl ? ' (含 base64 数据)' : '';
              lines.push(`  [${i + 1}] ${img.name || '(未命名)'} — ${dims} [${kindName}]${hasData}`);
            }
          }
        }

        return lines.join('\n');
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      return `提取PDF图片失败: ${(error as Error).message}`;
    }
  },
});

function ImageKindLabel(kind: number): string {
  const labels: Record<number, string> = {
    1: 'GRAYSCALE_1BPP',
    2: 'RGB_24BPP',
    3: 'RGBA_32BPP',
  };
  return labels[kind] ?? `UNKNOWN(${kind})`;
}





export const pdfSaveImages = tool({
  description: '保存PDF文件中的嵌入图片到本地目录。支持按页码筛选，自动创建输出目录。',
  inputSchema: z.object({
    filePath: z.string().describe('PDF文件的路径（绝对路径或相对当前工作目录的路径）'),
    outputDir: z.string().describe('保存图片的输出目录路径（绝对路径或相对当前工作目录的路径）'),
    imageThreshold: z.number().optional().describe('最小图片尺寸（像素），小于此值的图片被忽略（默认 80）'),
    pageNumbers: z.array(z.number()).optional().describe('指定提取的页码数组（从 1 开始），不传则提取所有页'),
  }),
  execute: async ({ filePath, outputDir, imageThreshold, pageNumbers }): Promise<string> => {
    try {
      const pdfPath = resolvePath(filePath);
      const outDir = resolvePath(outputDir);

      // 确保输出目录存在
      await fs.mkdir(outDir, { recursive: true });

      const buffer = await fs.readFile(pdfPath);
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const parseParams: any = {
          imageBuffer: true,
          imageDataUrl: false,
          imageThreshold: imageThreshold ?? 80,
        };
        if (pageNumbers && pageNumbers.length > 0) {
          parseParams.partial = pageNumbers;
        }

        const result: ImageResult = await parser.getImage(parseParams);

        const savedFiles: string[] = [];
        let totalSaved = 0;

        for (const page of result.pages) {
          const { pageNumber, images } = page;
          if (!images || images.length === 0) continue;

          for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!img.data || img.data.length === 0) continue;

            // 清理文件名中的非法字符
            const safeName = (img.name || `page_${pageNumber}_img_${i + 1}`)
              .replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
            const fileName = `${safeName}.png`;
            const filePath = `${outDir}/${fileName}`;

            await fs.writeFile(filePath, img.data);
            savedFiles.push(`  [${totalSaved + 1}] ${fileName} — ${img.width}x${img.height}px (第 ${pageNumber} 页)`);
            totalSaved++;
          }
        }

        if (totalSaved === 0) {
          return `未从 PDF 中找到嵌入图片（阈值: ${imageThreshold ?? 80}px）。`;
        }

        return [
          `成功保存 ${totalSaved} 张图片到: ${outDir}`,
          ...savedFiles,
        ].join('\n');
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      return `保存PDF图片失败: ${(error as Error).message}`;
    }
  },
});
