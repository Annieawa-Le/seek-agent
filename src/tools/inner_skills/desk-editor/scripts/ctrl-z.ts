import { tool } from 'ai';
import { z } from 'zod';
import { deskEditManager } from '../../../desk-edit';

export const ctrlZ = tool({
  description: '撤销当前会话的上一次操作（line_cursor / line_paste）。',
  inputSchema: z.object({
    id: z.string().describe('编辑会话 ID'),
  }),
  execute: async ({ id }) => {
    const tid = id?.trim();
    if (!deskEditManager.isActive()) return '未处于编辑模式';
    const { result } = deskEditManager.undo(tid);
    return result;
  },
});
