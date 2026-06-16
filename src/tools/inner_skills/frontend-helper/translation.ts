/**
 * translation.ts — frontend-helper 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'generate_component': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const name = (args?.componentName ?? '(?)') as string;
      const fw = (args?.framework ?? '(?)') as string;
      return `生成组件: ${name} (${fw})`;
    },
    collapse: 'after-round',
  },
  'generate_styles': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const sel = (args?.selector ?? '(?)') as string;
      return `生成样式: ${sel}`;
    },
    collapse: 'after-round',
  },
  'analyze_template': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const checks = (args?.checks ?? 'all') as string;
      return `分析模板 (${checks})`;
    },
    collapse: 'single',
  },
  'frontend-helper-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 frontend-helper 技能说明',
    collapse: 'single',
  },
};
export default translations;
