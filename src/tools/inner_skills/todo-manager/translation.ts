/**
 * translation.ts — todo-manager 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'todo_save': {
    icon: '■',
    category: 'desk',
    callLabel: (args) => {
      const name = (args?.name ?? '(全部)') as string;
      return `持久化待办: ${name}`;
    },
    collapse: 'after-round',
  },
  'todo_load': {
    icon: '■',
    category: 'desk',
    callLabel: (args) => {
      const name = (args?.name ?? '(全部)') as string;
      return `加载待办: ${name}`;
    },
    collapse: 'after-round',
  },
  'todo_list_saved': {
    icon: '■',
    category: 'desk',
    callLabel: () => '列出已保存的待办',
    collapse: 'after-round',
  },
  'todo_delete_saved': {
    icon: '■',
    category: 'desk',
    callLabel: (args) => {
      const name = (args?.name ?? '(?)') as string;
      return `删除已保存待办: ${name}`;
    },
    collapse: 'after-round',
  },
  'todo-manager-prompt-get': {
    icon: '■',
    category: 'desk',
    callLabel: () => '查看 todo-manager 技能说明',
    collapse: 'single',
  },
};
export default translations;
