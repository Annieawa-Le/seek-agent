import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { imageSize } from 'image-size';

/** 常见格式的色彩模式映射 */
function getColorMode(format: string, buffer: Buffer): string {
  switch (format) {
    case 'png': {
      // PNG color type 在 IHDR 数据块的第 9 字节 (数据块起始偏移 16 + 8 = 24)
      // 更精确: PNG sig (8) + IHDR length (4) + "IHDR" (4) = 16, color type 在 offset 25
      if (buffer.length < 26) return '未知';
      const colorType = buffer[25];
      const modes: Record<number, string> = {
        0: '灰度 (Grayscale)',
        2: 'RGB 真彩色',
        3: '索引色 (Indexed)',
        4: '灰度+Alpha',
        6: 'RGBA 真彩色+Alpha',
      };
      return modes[colorType] || `未知 (colorType=${colorType})`;
    }
    case 'jpeg': {
      // 扫描 SOF0/1/2 marker 获取通道数
      let i = 2;
      while (i < buffer.length - 1) {
        if (buffer[i] === 0xFF) {
          const marker = buffer[i + 1];
          // SOF0-SOF2: 0xC0-0xC2, SOF3: 0xC3 (lossless), SOF5-SOF7: 0xC5-0xC7, SOF9-SOF11: 0xC9-0xCB, SOF13-SOF15: 0xCD-0xCF
          if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
            if (i + 9 <= buffer.length) {
              const numComponents = buffer[i + 9];
              const modes: Record<number, string> = {
                1: '灰度 (Grayscale)',
                3: 'YCbCr (彩色)',
                4: 'CMYK',
              };
              return modes[numComponents] || `未知 (${numComponents} 通道)`;
            }
          }
          // Skip marker length (big-endian 16-bit)
          if (marker !== 0xD8 && marker !== 0xD9 && marker !== 0x00) {
            const length = (buffer[i + 2] << 8) + buffer[i + 3];
            i += length + 2;
            continue;
          }
        }
        i++;
      }
      return 'RGB (默认推断)';
    }
    case 'gif':
      return '索引色 (Indexed, LZW)';
    case 'bmp': {
      // offset 28: bits per pixel
      if (buffer.length < 30) return '未知';
      const bpp = buffer.readUInt16LE(28);
      if (bpp <= 8) return `索引色 (${bpp}位)`;
      if (bpp === 16) return 'RGB 高彩色 (16位)';
      if (bpp === 24) return 'RGB 真彩色 (24位)';
      if (bpp === 32) return 'RGBA 真彩色+Alpha (32位)';
      return `RGB (${bpp}位)`;
    }
    case 'webp': {
      // WebP 格式判断: VP8/VP8L/VP8X
      if (buffer.length > 20) {
        const webpType = buffer.slice(12, 16).toString('ascii');
        const typeMap: Record<string, string> = {
          'VP8 ': 'VP8 (有损)',
          'VP8L': 'VP8L (无损, 可能带Alpha)',
          'VP8X': 'VP8X (扩展, 支持Alpha/动画)',
        };
        return typeMap[webpType] || `WEBP (${webpType})`;
      }
      return 'WEBP';
    }
    default:
      return '未知';
  }
}

export const imageInfo = tool({
  description: `读取单张图片文件的元信息，包括格式、尺寸（宽高）、色彩模式、文件大小等。返回结构化数据。`,
  inputSchema: z.object({
    filePath: z.string().describe('图片文件的路径（绝对路径或相对当前工作目录的路径）'),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const resolvedPath = path.resolve(filePath);

      // 检查文件是否存在并获取大小
      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        return `错误: 文件不存在 - ${resolvedPath}`;
      }

      const fileSizeBytes = stat.size;

      // 读取文件前 64KB（足够解析大多数图片头信息）
      const buffer = await fs.readFile(resolvedPath);

      // 使用 image-size 获取格式和尺寸
      let dimensions: { width: number; height: number; type?: string } | null = null;
      try {
        const result = imageSize(buffer);
        if (result) {
          dimensions = {
            width: result.width,
            height: result.height,
            type: result.type,
          };
        }
      } catch {
        // image-size 可能不支持某些格式
      }

      if (!dimensions) {
        return `无法识别的图片格式: ${resolvedPath}`;
      }

      const format = dimensions.type || '未知';
      const colorMode = getColorMode(format, buffer);

      // 格式化文件大小
      const sizeKB = (fileSizeBytes / 1024).toFixed(1);
      const sizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

      return [
        `图片路径: ${resolvedPath}`,
        `文件大小: ${fileSizeBytes} B (${sizeKB} KB / ${sizeMB} MB)`,
        `格式: ${format.toUpperCase()}`,
        `尺寸: ${dimensions.width} × ${dimensions.height} 像素`,
        `色彩模式: ${colorMode}`,
      ].join('\n');
    } catch (error: any) {
      return `执行错误: ${error.message}`;
    }
  },
});
