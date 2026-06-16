import { tool } from 'ai';
import { z } from 'zod';
import { deskEditManager } from '../../desk-edit';

export const deskEdit = tool({
  description: [
    '进入一个文件的桌面编辑模式，分配一个 id。',
    '光标初始在文件末尾。同一个 id 不可重复打开。',
    '进入编辑模式后，仅桌面编辑工具可用。',
  ].join('\n'),
  inputSchema: z.object({
    id: z.string().describe('编辑会话 ID，用于后续操作标识此文件'),
    filePath: z.string().describe('要编辑的文件路径'),
  }),
  execute: async ({ id, filePath }) => {
    const tid = id?.trim();
    if (!tid) return '❌ id 不能为空';
    if (deskEditManager.hasSession(tid)) {
      const activeIds = deskEditManager.getActiveIds().map(s => `"${s}"`).join(', ');
      return `会话 "${tid}" 已打开。\n当前活跃会话: ${activeIds}`;
    }
    const { result } = await deskEditManager.enter(tid, filePath);
    return result;
  },
});
