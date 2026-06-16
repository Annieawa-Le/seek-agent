/**
 * translation.ts — web-accessor 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'tavily_search': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const q = (args?.query ?? '(?)') as string;
      return `Tavily 搜索: ${q}`;
    },
    collapse: 'after-round',
  },
  'tavily_extract': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const urls = (args?.urls ?? '(?)') as string;
      const short = urls.length > 60 ? urls.slice(0, 57) + '...' : urls;
      return `Tavily 提取: ${short}`;
    },
    collapse: 'single',
  },
  'tavily_crawl': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const url = (args?.url ?? '(?)') as string;
      const depth = args?.max_depth ?? 1;
      return `Tavily 爬取: ${url} (深度 ${depth})`;
    },
    collapse: 'after-round',
  },
  'tavily_map': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const url = (args?.url ?? '(?)') as string;
      return `Tavily 站点地图: ${url}`;
    },
    collapse: 'after-round',
  },
  'tavily_research': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const input = (args?.input ?? '(?)') as string;
      const short = input.length > 50 ? input.slice(0, 47) + '...' : input;
      return `Tavily 深度研究: ${short}`;
    },
    collapse: 'after-round',
  },
  'web-accessor-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 web-accessor 技能说明',
    collapse: 'single',
  },
};
export default translations;
