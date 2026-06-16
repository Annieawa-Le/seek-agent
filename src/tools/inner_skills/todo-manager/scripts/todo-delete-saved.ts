import { tool } from 'ai';
import { z } from 'zod';
import { readTodos, writeTodos } from './data';

export const todoDeleteSaved = tool({
  description: '从磁盘上删除一个已持久化的 todo。不影响当前会话中的同名 todo。',
  inputSchema: z.object({
    name: z.string().describe('要删除的 todo 名称'),
  }),
  execute: async ({ name }) => {
    const todos = await readTodos();
    const idx = todos.findIndex(t => t.name === name);
    if (idx === -1) {
      return `❌ 磁盘上未找到名为 "${name}" 的 todo。`;
    }

    todos.splice(idx, 1);
    await writeTodos(todos);

    return `🗑️ 已从磁盘删除持久化的 todo "${name}"。`;
  },
});
