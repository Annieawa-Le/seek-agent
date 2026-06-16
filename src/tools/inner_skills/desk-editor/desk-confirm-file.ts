import { tool } from 'ai';
import { z } from 'zod';
import { deskEditManager } from '../../desk-edit';

export const deskConfirmFile = tool({
  description: '将指定会话的最新 ref（含光标标记）拉到消息末尾。id 不填则重置所有。',
  inputSchema: z.object({
    id: z.string().optional().describe('会话 ID（不填则重置所有）'),
  }),
  execute: async ({ id }) => {
    const tid = id?.trim();
    if (!deskEditManager.isActive()) return '❌ 未处于编辑模式';
    if (tid) {
      if (!deskEditManager.hasSession(tid)) {
        const activeList = deskEditManager.getActiveIds().map(s => `"${s}"`).join(', ');
        return `❌ 未找到会话：${tid}。当前活跃会话: ${activeList}`;
      }
      deskEditManager.resetRefPin(tid);
      return `✅ 已重置会话 "${tid}" 的钉扎状态`;
    }
    for (const sid of deskEditManager.getActiveIds()) deskEditManager.resetRefPin(sid);
    return `✅ 已重置所有会话（${deskEditManager.sessionCount} 个）的钉扎状态`;
  },
});
