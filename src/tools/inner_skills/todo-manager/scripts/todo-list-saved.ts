import { tool } from 'ai';
import { z } from 'zod';
import { readTodos } from './data';

export const todoListSaved = tool({
  description: '列出磁盘上所有已持久化的 todo 及其步骤数概要，不加载到会话。',
  inputSchema: z.object({}),
  execute: async () => {
    const todos = await readTodos();
    if (todos.length === 0) {
      return '📭 磁盘上没有已持久化的 todo。';
    }

    const lines = todos.map((t, i) => {
      const done = t.steps.filter(s => s.completed).length;
      return `  ${i + 1}. "${t.name}" — ${done}/${t.steps.length} 步完成`;
    });

    return `💿 已持久化的 todo（共 ${todos.length} 项）：\n${lines.join('\n')}`;
  },
});
