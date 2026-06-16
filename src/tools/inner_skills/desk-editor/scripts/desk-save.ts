import { tool } from 'ai';
import { z } from 'zod';
import { deskEditManager } from '../../../desk-edit';

export const deskSave = tool({
  description: '保存修改到磁盘并退出编辑模式。id 可选，不填则保存所有。',
  inputSchema: z.object({
    id: z.string().optional().describe('会话 ID（不填则保存所有）'),
  }),
  execute: async ({ id }) => {
    const tid = id?.trim();
    const { result } = tid ? await deskEditManager.saveSession(tid) : await deskEditManager.saveAll();
    return result;
  },
});
