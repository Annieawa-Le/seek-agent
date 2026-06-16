/**
 * translation.ts — code-reader 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'scanning_function': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `扫描函数: ${fp}`;
    },
    collapse: 'single',
  },
  'scanning_class': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `扫描类: ${fp}`;
    },
    collapse: 'single',
  },
  'read_function': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const fn = (args?.functionName ?? '(?)') as string;
      return `读取函数: ${fp} (${fn})`;
    },
    collapse: 'single',
  },
  'read_class': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const cn = (args?.className ?? '(?)') as string;
      return `读取类: ${fp} (${cn})`;
    },
    collapse: 'single',
  },
  'read_package': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `读取包导入: ${fp}`;
    },
    collapse: 'single',
  },
  'scanning_tag': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const tag = args?.tagName ? ` (${args.tagName})` : '';
      return `扫描标签: ${fp}${tag}`;
    },
    collapse: 'single',
  },
  'scanning_script': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `扫描脚本块: ${fp}`;
    },
    collapse: 'single',
  },
  'jump_to_definition': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const sym = (args?.symbolName ?? '(?)') as string;
      return `跳转到定义: ${fp} (${sym})`;
    },
    collapse: 'single',
  },
  'code-reader-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 code-reader 技能说明',
    collapse: 'single',
  },
};
export default translations;
