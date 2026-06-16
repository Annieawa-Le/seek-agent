import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

interface ImageItem {
  url: string;
  alt?: string;
  format?: string;
}

const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'image/x-icon': '.ico',
};

async function downloadSingle(
  url: string,
  outputDir: string,
  index: number,
  timeout: number,
): Promise<{ url: string; status: string; localPath?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      return { url, status: 'failed', error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());

    // 确定扩展名：优先从 URL 推断，再回退到 content-type
    const cleanUrl = url.split('?')[0].split('#')[0];
    let ext = path.extname(cleanUrl).toLowerCase();
    if (!ext || !['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico', '.tiff'].includes(ext)) {
      ext = MIME_EXT_MAP[contentType] || '.bin';
    }

    const fileName = `image_${String(index).padStart(3, '0')}${ext}`;
    const filePath = path.join(outputDir, fileName);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return { url, status: 'downloaded', localPath: filePath };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { url, status: 'failed', error: 'timeout' };
    }
    return { url, status: 'failed', error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export const downloadImages = tool({
  description: `将图片 URL 列表批量下载到本地指定目录。支持设置并发数、超时时间，自动生成文件名。返回每个文件的下载状态和本地路径。`,
  inputSchema: z.object({
    images: z.string().describe(
      '图片信息列表的 JSON 字符串，格式为 [{url, alt, format}]，或直接传入 URL 字符串数组的 JSON',
    ),
    output_dir: z.string().describe('保存图片的本地目录路径（相对或绝对路径）'),
    concurrency: z.number().optional().default(3).describe('并发下载数，默认 3'),
    timeout: z.number().optional().default(30000).describe('单个图片下载超时时间（毫秒），默认 30000'),
  }),
  execute: async ({ images, output_dir, concurrency = 3, timeout = 30000 }): Promise<string> => {
    try {
      // 解析 images 参数
      let items: ImageItem[] = [];
      try {
        const parsed = JSON.parse(images);
        if (Array.isArray(parsed)) {
          if (parsed.length > 0 && typeof parsed[0] === 'string') {
            // 纯 URL 字符串数组
            items = parsed.map((u: string) => ({ url: u }));
          } else {
            items = parsed as ImageItem[];
          }
        }
      } catch {
        return `解析 images 参数失败，请提供有效的 JSON 格式。示例: [{"url":"https://..."}] 或 ["https://..."]`;
      }

      if (items.length === 0) {
        return '没有需要下载的图片';
      }

      // 校验所有 URL
      const validItems = items.filter(item => {
        try {
          new URL(item.url);
          return true;
        } catch {
          return false;
        }
      });

      if (validItems.length === 0) {
        return '没有有效的图片 URL';
      }

      if (validItems.length < items.length) {
        // 有无效 URL，但继续处理
      }

      // 并发控制：worker 模式
      const results: { url: string; status: string; localPath?: string; error?: string }[] = [];
      const queue = [...validItems];

      async function worker() {
        while (queue.length > 0) {
          const item = queue.shift()!;
          const idx = items.indexOf(item) + 1;
          const result = await downloadSingle(item.url, output_dir, idx, timeout);
          results.push(result);
        }
      }

      const workerCount = Math.min(concurrency, validItems.length);
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);

      // 统计
      const success = results.filter(r => r.status === 'downloaded').length;
      const failed = results.filter(r => r.status === 'failed').length;

      const lines: string[] = [];
      lines.push(`下载完成: 成功 ${success}, 失败 ${failed}, 共 ${results.length} 个`);
      lines.push(`保存目录: ${path.resolve(output_dir)}`);

      if (success > 0) {
        lines.push('');
        lines.push('--- 成功 ---');
        for (const r of results) {
          if (r.status === 'downloaded') {
            lines.push(`  ✅ ${r.localPath}`);
          }
        }
      }

      if (failed > 0) {
        lines.push('');
        lines.push('--- 失败 ---');
        for (const r of results) {
          if (r.status === 'failed') {
            lines.push(`  ❌ ${r.url} — ${r.error}`);
          }
        }
      }

      return lines.join('\n');
    } catch (error) {
      return `下载图片失败: ${(error as Error).message}`;
    }
  },
});
