/**
 * translation.ts — ts-debug 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'ts_typecheck': {
    icon: '✓',
    category: 'exec',
    callLabel: (args) => {
      const filter = args?.filter as string | undefined;
      const cwd = args?.cwd as string | undefined;
      return `类型检查${cwd ? ` (${cwd})` : ''}${filter ? ` [过滤:${filter}]` : ''}`;
    },
    collapse: 'after-round',
  },
  'ts_run_test': {
    icon: '▶',
    category: 'exec',
    callLabel: (args) => `运行测试: ${(args?.script ?? '?') as string}`,
    collapse: 'after-round',
  },
  'ts_node_check': {
    icon: '✓',
    category: 'exec',
    callLabel: (args) => `语法检查: ${(args?.file ?? '?') as string}`,
    collapse: 'after-round',
  },
  'ts_build': {
    icon: '⚙',
    category: 'exec',
    callLabel: (args) => `构建: ${(args?.target ?? 'renderer') as string}`,
    collapse: 'after-round',
  },
  'ts-debug-prompt-get': {
    icon: '📘',
    category: 'exec',
    callLabel: () => '查看 ts-debug 技能说明',
    collapse: 'single',
  },
};
export default translations;
