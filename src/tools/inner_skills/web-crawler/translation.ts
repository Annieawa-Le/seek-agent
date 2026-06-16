/**
 * translation.ts — web-crawler 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'fetch_page': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const url = (args?.url ?? '(?)') as string;
      return `获取页面: ${url}`;
    },
    collapse: 'single',
  },
  'crawl_site': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const url = (args?.url ?? '(?)') as string;
      const depth = args?.max_depth ?? 1;
      return `爬取站点: ${url} (深度 ${depth})`;
    },
    collapse: 'after-round',
  },
  'extract_links': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const url = (args?.url ?? '(?)') as string;
      return `提取链接: ${url}`;
    },
    collapse: 'single',
  },
  'search_web': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const q = (args?.query ?? '(?)') as string;
      return `搜索网页: ${q}`;
    },
    collapse: 'after-round',
  },
  'web-crawler-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 web-crawler 技能说明',
    collapse: 'single',
  },
};
export default translations;
