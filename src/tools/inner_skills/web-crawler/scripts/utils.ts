/**
 * web-crawler 共享工具函数
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

/** 从 HTML 中提取 <title> 内容 */
export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

/** 从 HTML 中提取 <base> URL */
export function extractBaseUrl(html: string, pageUrl: string): string {
  const match = html.match(/<base[^>]+href\s*=\s*["']([^"']*)["']/i);
  if (match) {
    try {
      return new URL(match[1], pageUrl).href;
    } catch { /* fall through */ }
  }
  return pageUrl;
}

/** 将 HTML 转换为可读文本 */
export function htmlToText(html: string): string {
  let text = html
    // 移除 script/style/nav/footer/header 块
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    // 块级标签换行
    .replace(/<br\s*[/]?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<th[^>]*>/gi, '\t')
    // 移除剩余标签
    .replace(/<[^>]+>/g, '')
    // 解码 HTML 实体
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#\d+;/g, ' ')
    .replace(/&\w+;/g, ' ')
    // 压缩空白
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return text;
}

/** 从 HTML 中提取所有链接，返回绝对 URL 列表 */
export function extractHrefs(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRegex = /<a[^>]+href\s*=\s*["']([^"']*)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      continue;
    }
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      // 去掉 hash
      const cleanUrl = absoluteUrl.split('#')[0];
      if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
        links.push(cleanUrl);
      }
    } catch { /* 忽略无效 URL */ }
  }

  return [...new Set(links)];
}

/** 判断 URL 是否同域名（含 www 归一化） */
export function isSameDomain(urlA: string, urlB: string): boolean {
  try {
    const hostA = new URL(urlA).hostname.replace(/^www\./, '');
    const hostB = new URL(urlB).hostname.replace(/^www\./, '');
    return hostA === hostB;
  } catch {
    return false;
  }
}

/** 截取文本，保留前后文完整性 */
export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n... [内容已截断，原文过长]';
}
