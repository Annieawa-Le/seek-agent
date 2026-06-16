import { tool } from 'ai';
import { z } from 'zod';
import { readTodos } from './data';
import { getTodos, setTodos } from '../../todo-state';

export const todoLoad = tool({
  description: '从磁盘加载已持久化的 todo 到当前会话。不指定 name 则加载所有已保存的 todo。同名 todo 会覆盖会话中的当前版本。',
  inputSchema: z.object({
    name: z.string().optional().describe('要加载的 todo 名称，不填则加载所有已保存的 todo'),
  }),
  execute: async ({ name }) => {
    const diskTodos = await readTodos();
    if (diskTodos.length === 0) {
      return '📭 磁盘上没有任何已持久化的 todo。';
    }

    const toLoad = name
      ? diskTodos.filter(t => t.name === name)
      : diskTodos;

    if (name && toLoad.length === 0) {
      return `❌ 磁盘上未找到名为 "${name}" 的 todo。`;
    }

    const sessionTodos = getTodos();
    for (const t of toLoad) {
      const idx = sessionTodos.findIndex(e => e.name === t.name);
      if (idx >= 0) sessionTodos[idx] = t;
      else sessionTodos.push(t);
    }
    setTodos(sessionTodos);

    const names = toLoad.map(t => `"${t.name}"`).join('、');
    const summaries = toLoad.map(t => `  • ${t.name}（${t.steps.length} 步）`).join('\n');
    return `📂 已加载 ${names} 到当前会话：\n${summaries}`;
  },
});

