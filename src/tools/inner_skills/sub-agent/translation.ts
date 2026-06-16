/**
 * translation.ts — sub-agent 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'spawn_agent': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const mode = (args?.mode ?? '(?)') as string;
      const name = (args?.name ?? '(?)') as string;
      return `创建子模型: ${name} (${mode})`;
    },
    collapse: 'after-round',
  },
  'agent_task': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const name = (args?.name ?? '(?)') as string;
      const task = (args?.task ?? '') as string;
      const short = task.length > 40 ? task.slice(0, 37) + '...' : task;
      return `委派任务: ${name} (${short})`;
    },
    collapse: 'after-round',
  },
  'agent_query': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const name = (args?.name ?? '(?)') as string;
      return `查询子模型: ${name}`;
    },
    collapse: 'single',
  },
  'agent_fire': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const name = (args?.name ?? '(?)') as string;
      return `销毁子模型: ${name}`;
    },
    collapse: 'after-round',
  },
  'a_submission': {
    icon: '■',
    category: 'other',
    callLabel: (args) => {
      const summary = (args?.summary ?? '(?)') as string;
      const short = summary.length > 40 ? summary.slice(0, 37) + '...' : summary;
      return `提交结果: ${short}`;
    },
    collapse: 'after-round',
  },
};
export default translations;
