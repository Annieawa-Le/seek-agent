/**
 * translation.ts — browser-control 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'browser_launch': {
    icon: '▲',
    category: 'exec',
    callLabel: (args) => {
      const headless = args?.headless ? ' (无头)' : '';
      return `启动浏览器${headless}`;
    },
  },
  'browser_navigate': {
    icon: '▲',
    category: 'read',
    callLabel: (args) => {
      const url = (args?.url ?? '(?)') as string;
      return `打开页面: ${url}`;
    },
    collapse: 'single',
  },
  'browser_click': {
    icon: '▲',
    category: 'exec',
    callLabel: (args) => {
      const selector = (args?.selector ?? '(?)') as string;
      return `点击: ${selector}`;
    },
    collapse: 'single',
  },
  'browser_type': {
    icon: '▲',
    category: 'exec',
    callLabel: (args) => {
      const selector = (args?.selector ?? '(?)') as string;
      const len = (args?.text as string)?.length ?? 0;
      return `输入(${len}字符)到: ${selector}`;
    },
    collapse: 'single',
  },
  'browser_press': {
    icon: '▲',
    category: 'exec',
    callLabel: (args) => {
      const key = (args?.key ?? '(?)') as string;
      return `按键: ${key}`;
    },
    collapse: 'single',
  },
  'browser_scroll': {
    icon: '▲',
    category: 'exec',
    callLabel: (args) => {
      const direction = (args?.direction ?? 'down') as string;
      const selector = (args?.selector as string) ?? '';
      return selector ? `滚动到: ${selector}` : `滚动: ${direction}`;
    },
    collapse: 'single',
  },
  'browser_extract': {
    icon: '▲',
    category: 'read',
    callLabel: (args) => {
      const mode = (args?.mode ?? 'text') as string;
      return `提取页面: ${mode}`;
    },
    collapse: 'single',
  },
  'browser_screenshot': {
    icon: '▲',
    category: 'read',
    callLabel: () => '截图页面',
    collapse: 'single',
  },
  'browser_execute_js': {
    icon: '▲',
    category: 'exec',
    callLabel: () => '执行 JS',
    collapse: 'single',
  },
  'browser_wait': {
    icon: '▲',
    category: 'exec',
    callLabel: (args) => {
      const selector = (args?.selector ?? '(?)') as string;
      return `等待元素: ${selector}`;
    },
    collapse: 'single',
  },
  'browser_status': {
    icon: '▲',
    category: 'exec',
    callLabel: () => '查看浏览器状态',
    collapse: 'single',
  },
  'browser_close': {
    icon: '▲',
    category: 'exec',
    callLabel: () => '关闭浏览器',
    collapse: 'single',
  },
  'browser_tabs': {
    icon: '▲',
    category: 'read',
    callLabel: () => '列出标签页',
    collapse: 'single',
  },
  'browser_switch_tab': {
    icon: '▲',
    category: 'exec',
    callLabel: (args) => {
      const index = (args?.index ?? '(?)') as number;
      return `切换标签页: [${index}]`;
    },
    collapse: 'single',
  },
  'browser-control-prompt-get': {
    icon: '▲',
    category: 'read',
    callLabel: () => '查看 browser-control 技能说明',
    collapse: 'single',
  },
};
export default translations;


