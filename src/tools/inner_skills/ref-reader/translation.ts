/**
 * translation.ts — ref-reader 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'list_refs': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const sn = (args?.skillName ?? '(全部)') as string;
      return `列出参考文献: ${sn}`;
    },
    collapse: 'single',
  },
  'read_ref': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const sn = (args?.skillName ?? '(?)') as string;
      const fn = (args?.fileName ?? '(?)') as string;
      return `读取参考文献: ${sn} (${fn})`;
    },
    collapse: 'single',
  },
  'search_ref': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const sn = (args?.skillName ?? '(?)') as string;
      const kw = (args?.keyword ?? '(?)') as string;
      return `搜索参考文献: ${sn} (${kw})`;
    },
    collapse: 'after-round',
  },
  'find_ref': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const pat = (args?.pattern ?? '(?)') as string;
      return `查找参考文献: ${pat}`;
    },
    collapse: 'after-round',
  },
  'ref-reader-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 ref-reader 技能说明',
    collapse: 'single',
  },
};
export default translations;
