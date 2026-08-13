/**
 * translation.ts — code-graph 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'list_symbols': {
    icon: '📊',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `列出符号: ${fp}`;
    },
    collapse: 'single',
  },
  'read_symbol': {
    icon: '📖',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const sym = (args?.symbolName ?? '(?)') as string;
      return `读取符号: ${fp} (${sym})`;
    },
    collapse: 'single',
  },
  'find_references': {
    icon: '🔍',
    category: 'search',
    callLabel: (args) => {
      const sym = (args?.symbolName ?? '(?)') as string;
      return `查找引用: ${sym}`;
    },
    collapse: 'single',
  },
  'trace_callers': {
    icon: '⬅️',
    category: 'search',
    callLabel: (args) => {
      const fn = (args?.functionName ?? '(?)') as string;
      return `追踪调用方: ${fn}`;
    },
    collapse: 'single',
  },
  'trace_callees': {
    icon: '➡️',
    category: 'search',
    callLabel: (args) => {
      const fn = (args?.functionName ?? '(?)') as string;
      return `追踪被调: ${fn}`;
    },
    collapse: 'single',
  },
  'trace_chain': {
    icon: '🕸️',
    category: 'search',
    callLabel: (args) => {
      const fn = (args?.functionName ?? '(?)') as string;
      return `调用链: ${fn}`;
    },
    collapse: 'single',
  },
  'file_deps': {
    icon: '🔗',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `文件依赖: ${fp}`;
    },
    collapse: 'single',
  },
  'blast_radius': {
    icon: '💥',
    category: 'search',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const sym = args?.symbolName ? ` (${args.symbolName})` : '';
      return `影响面: ${fp}${sym}`;
    },
    collapse: 'single',
  },
};
export default translations;
