import { tool } from 'ai';
import { z } from 'zod';
import { deskEditManager } from '../../desk-edit';

export const deskCancel = tool({
  description: '放弃修改并退出编辑模式。id 可选，不填则取消所有。',
  inputSchema: z.object({
    id: z.string().optional().describe('会话 ID（不填则取消所有）'),
  }),
  execute: async ({ id }) => {
    const tid = id?.trim();
    return tid ? deskEditManager.cancelSession(tid) : deskEditManager.cancelAll();
  },
});
