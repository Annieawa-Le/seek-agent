/**
 * image-crawler 共享工具函数
 */

/** 按 URL 获取 HTML 内容，支持超时和自定义 UA */
export async function fetchHtml(
  url: string,
  timeout: number = 15000,
  userAgent?: string,
): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.statusText ? ': ' + res.statusText : ''}`);
    }

    const html = await res.text();
    return { html, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 HTML 中提取 <base> URL */
export function extractBaseUrl(html: string, pageUrl: string): string {
  const match = html.match(/<base[^>]+href\s*=\s*["']([^"']*)["']/i);
  if (match) {
    try {
      return new URL(match[1], pageUrl).href;
    } catch {
      /* fall through */
    }
  }
  return pageUrl;
}
