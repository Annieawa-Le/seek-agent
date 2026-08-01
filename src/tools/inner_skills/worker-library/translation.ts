/**
 * translation.ts — worker-library 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'list_workers': {
    icon: '👥',
    category: 'read',
    callLabel: () => '列出预制员工库',
    collapse: 'after-round',
  },
  'get_worker': {
    icon: '👤',
    category: 'read',
    callLabel: (args) => {
      const id = (args?.id ?? '(?)') as string;
      return `读取员工资料: ${id}`;
    },
    collapse: 'after-round',
  },
  'spawn_worker': {
    icon: '👷',
    category: 'exec',
    callLabel: (args) => {
      const worker = (args?.worker ?? '(?)') as string;
      const name = (args?.name ?? '(?)') as string;
      return `按预制员工创建子模型: ${worker} → ${name}`;
    },
    collapse: 'after-round',
  },
  'worker-library-prompt-get': {
    icon: '📖',
    category: 'read',
    callLabel: () => '查看 worker-library 技能说明',
    collapse: 'single',
  },
};
export default translations;

