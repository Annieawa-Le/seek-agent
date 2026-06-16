import { tool } from 'ai';
import { z } from 'zod';
import { fetchHtml, extractBaseUrl } from './utils';

function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    if (src.startsWith('data:') || src.startsWith('javascript:') || src.startsWith('#')) {
      return null;
    }
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

function getFormat(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  const match = clean.match(/\.(\w+)$/);
  return match ? match[1].toLowerCase() : '';
}

function isAllowedFormat(format: string, formats?: string): boolean {
  if (!formats || formats.trim() === '') return true;
  const allowed = formats.split(',').map(f => f.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return true;
  if (!format) return true; // 无扩展名的图片保留
  return allowed.includes(format);
}

export const extractImages = tool({
  description: `从指定网页 URL 中提取所有图片资源，返回图片的完整 URL、alt 文本、文件扩展名等信息。支持设置图片最小尺寸过滤、只爬取特定格式等选项。`,
  inputSchema: z.object({
    url: z.string().describe('目标网页的完整 URL（如 https://example.com/gallery）'),
    min_width: z.number().optional().default(0).describe('图片最小宽度（像素），低于此值的图片将被过滤，默认 0 不过滤'),
    min_height: z.number().optional().default(0).describe('图片最小高度（像素），低于此值的图片将被过滤，默认 0 不过滤'),
    formats: z.string().optional().default('').describe('允许的图片格式，逗号分隔（如 jpg,png,gif,webp），默认允许所有格式'),
    max_results: z.number().optional().default(50).describe('最大返回图片数量，默认 50'),
  }),
  execute: async ({ url, min_width = 0, min_height = 0, formats = '', max_results = 50 }): Promise<string> => {
    try {
      new URL(url); // 提前校验

      const { html, finalUrl } = await fetchHtml(url);
      const baseUrl = extractBaseUrl(html, finalUrl);
      const seen = new Set<string>();

      interface ImageInfo {
        url: string;
        alt: string;
        width?: number;
        height?: number;
        format: string;
      }

      const images: ImageInfo[] = [];

      // 提取 <img> 标签
      const imgRegex = /<img[\s\S]*?>/gi;
      let match: RegExpExecArray | null;
      while ((match = imgRegex.exec(html)) !== null) {
        const tag = match[0];

        // 优先提取实际图片 URL（懒加载属性优先于 src）
        const srcAttr =
          tag.match(/(?:data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["']/i)
          || tag.match(/src\s*=\s*["']([^"']+)["']/i);
        const alt = (tag.match(/alt\s*=\s*["']([^"']*)["']/i) || [, ''])[1];
        const width = tag.match(/width\s*=\s*["']?\s*(\d+)\s*["']?/i);
        const height = tag.match(/height\s*=\s*["']?\s*(\d+)\s*["']?/i);

        if (srcAttr) {
          const resolved = resolveUrl(srcAttr[1], baseUrl);
          if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            const format = getFormat(resolved);
            if (!isAllowedFormat(format, formats)) continue;
            images.push({
              url: resolved,
              alt,
              width: width ? parseInt(width[1], 10) : undefined,
              height: height ? parseInt(height[1], 10) : undefined,
              format,
            });
          }
        }

        // 提取 srcset 中的额外图片 URL
        const srcset = tag.match(/srcset\s*=\s*["']([^"']+)["']/i);
        if (srcset) {
          const urls = srcset[1].split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
          for (const u of urls) {
            const resolved = resolveUrl(u, baseUrl);
            if (resolved && !seen.has(resolved)) {
              seen.add(resolved);
              const format = getFormat(resolved);
              if (!isAllowedFormat(format, formats)) continue;
              images.push({ url: resolved, alt, format });
            }
          }
        }
      }

      // 提取 <picture> 下 <source> 的 srcset
      const pictureRegex = /<picture[\s\S]*?<\/picture>/gi;
      while ((match = pictureRegex.exec(html)) !== null) {
        const pictureBlock = match[0];
        const sourceRegex = /<source[\s\S]*?>/gi;
        let sourceMatch: RegExpExecArray | null;
        while ((sourceMatch = sourceRegex.exec(pictureBlock)) !== null) {
          const srcsetAttr = sourceMatch[0].match(/srcset\s*=\s*["']([^"']+)["']/i);
          if (srcsetAttr) {
            const urls = srcsetAttr[1].split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
            for (const u of urls) {
              const resolved = resolveUrl(u, baseUrl);
              if (resolved && !seen.has(resolved)) {
                seen.add(resolved);
                const format = getFormat(resolved);
                if (!isAllowedFormat(format, formats)) continue;
                images.push({ url: resolved, alt: '', format });
              }
            }
          }
        }
      }

      // 尺寸过滤（仅对已知尺寸的图片过滤）
      let filtered = images;
      if (min_width > 0 || min_height > 0) {
        filtered = images.filter(img => {
          if (min_width > 0 && img.width !== undefined && img.width < min_width) return false;
          if (min_height > 0 && img.height !== undefined && img.height < min_height) return false;
          return true;
        });
      }

      const result = filtered.slice(0, max_results);

      // 构建返回
      const lines: string[] = [];
      lines.push(`页面: ${finalUrl}`);
      lines.push(`共发现 ${seen.size} 个图片，过滤后 ${result.length} 个`);
      lines.push('');
      for (let i = 0; i < result.length; i++) {
        const img = result[i];
        const dims = img.width && img.height ? ` [${img.width}x${img.height}]` : '';
        const altText = img.alt ? ` alt="${img.alt.replace(/"/g, '\\"').slice(0, 60)}"` : '';
        lines.push(`${i + 1}. ${img.url}${dims}${altText}`);
      }

      return lines.join('\n');
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return `请求超时: ${url}`;
      }
      return `提取图片失败: ${(error as Error).message}`;
    }
  },
});
