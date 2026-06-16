/**
 * translation.ts — code-edit-detector 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'get_function_range': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const fn = (args?.functionName ?? '(?)') as string;
      return `获取函数范围: ${fp} (${fn})`;
    },
    collapse: 'single',
  },
  'find_matching_brace': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const ln = args?.lineNumber ?? '?';
      return `匹配花括号: ${fp} (行 ${ln})`;
    },
    collapse: 'single',
  },
  'wrap_by': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const start = args?.startLine ?? '?';
      const end = args?.endLine ?? '?';
      const ws = (args?.wrapString ?? '') as string;
      return `包裹代码: ${fp} (行 ${start}-${end}, "${ws}")`;
    },
    collapse: 'after-round',
  },
  'code-edit-detector-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 code-edit-detector 技能说明',
    collapse: 'single',
  },
};
export default translations;
