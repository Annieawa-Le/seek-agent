import { tool } from 'ai';
import { z } from 'zod';

interface ImageInfo {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  format?: string;
}

export const filterImages = tool({
  description: `对已提取的图片列表进行二次筛选，支持按关键词匹配 alt 文本、按文件名模式过滤、按尺寸范围过滤。`,
  inputSchema: z.object({
    images: z.string().describe('图片信息列表的 JSON 字符串，格式为 [{url, alt, width, height, format}]'),
    keyword: z.string().optional().default('').describe('alt 文本或 URL 中需包含的关键词（大小写不敏感），为空则不过滤'),
    min_width: z.number().optional().describe('最小宽度过滤（像素）'),
    min_height: z.number().optional().describe('最小高度过滤（像素）'),
    max_width: z.number().optional().describe('最大宽度过滤（像素）'),
    max_height: z.number().optional().describe('最大高度过滤（像素）'),
    formats: z.string().optional().default('').describe('允许的格式，逗号分隔（如 png,jpg），为空则不过滤'),
  }),
  execute: async ({ images, keyword = '', min_width, min_height, max_width, max_height, formats = '' }): Promise<string> => {
    try {
      let items: ImageInfo[];
      try {
        items = JSON.parse(images);
        if (!Array.isArray(items)) throw new Error('非数组');
      } catch {
        return '解析 images 失败，请提供有效的 JSON 数组，格式为 [{url, alt, width, height, format}]';
      }

      if (items.length === 0) {
        return '图片列表为空';
      }

      let filtered = items;

      // 关键词过滤
      if (keyword.trim()) {
        const kw = keyword.toLowerCase();
        filtered = filtered.filter(img =>
          (img.alt && img.alt.toLowerCase().includes(kw))
          || img.url.toLowerCase().includes(kw)
        );
      }

      // 格式过滤
      if (formats.trim()) {
        const allowed = formats.split(',').map(f => f.trim().toLowerCase()).filter(Boolean);
        if (allowed.length > 0) {
          filtered = filtered.filter(img => {
            if (!img.format) return false;
            return allowed.includes(img.format.toLowerCase());
          });
        }
      }

      // 尺寸过滤（width/height 为 undefined 时视为通过）
      if (min_width !== undefined) {
        filtered = filtered.filter(img => img.width === undefined || img.width >= min_width);
      }
      if (max_width !== undefined) {
        filtered = filtered.filter(img => img.width === undefined || img.width <= max_width);
      }
      if (min_height !== undefined) {
        filtered = filtered.filter(img => img.height === undefined || img.height >= min_height);
      }
      if (max_height !== undefined) {
        filtered = filtered.filter(img => img.height === undefined || img.height <= max_height);
      }

      const lines: string[] = [];
      lines.push(`过滤结果: ${filtered.length}/${items.length} 个`);
      lines.push('');
      for (let i = 0; i < filtered.length; i++) {
        const img = filtered[i];
        const dims = img.width && img.height ? ` [${img.width}x${img.height}]` : '';
        const altText = img.alt ? ` alt="${img.alt.replace(/"/g, '\\"').slice(0, 60)}"` : '';
        lines.push(`${i + 1}. ${img.url}${dims}${altText}`);
      }

      return lines.join('\n');
    } catch (error) {
      return `过滤图片失败: ${(error as Error).message}`;
    }
  },
});
