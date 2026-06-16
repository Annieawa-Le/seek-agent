import { tool } from 'ai';
import { z } from 'zod';
import { readTodos, writeTodos } from './data';
import { getTodos } from '../../../todo-state';

export const todoSave = tool({
  description: '将当前会话中的某个 todo 持久化保存到磁盘。不指定 name 则保存所有 todo。已存在的同名 todo 会被覆盖。',
  inputSchema: z.object({
    name: z.string().optional().describe('要持久化的 todo 名称，不填则保存当前会话中所有 todo'),
  }),
  execute: async ({ name }) => {
    const sessionTodos = getTodos();
    if (sessionTodos.length === 0) {
      return '📭 当前会话中没有 todo。';
    }

    const toSave = name
      ? sessionTodos.filter(t => t.name === name)
      : sessionTodos;

    if (name && toSave.length === 0) {
      return `❌ 当前会话中未找到名为 "${name}" 的 todo。`;
    }

    const diskTodos = await readTodos();
    for (const t of toSave) {
      const idx = diskTodos.findIndex(e => e.name === t.name);
      if (idx >= 0) diskTodos[idx] = t;
      else diskTodos.push(t);
    }
    await writeTodos(diskTodos);

    const names = toSave.map(t => `"${t.name}"`).join('、');
    return `💾 已持久化保存 ${names}。`;
  },
});

