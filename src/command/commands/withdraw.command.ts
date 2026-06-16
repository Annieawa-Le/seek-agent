import { Command } from '../types';

/**
 * /withdraw — 撤回上一条还没有 AI 响应的用户输入。
 *
 * 在消息列表中从后往前查找，找到最近一条
 * 还没有 AI 回复（无 agent 角色消息跟随）的用户输入，
 * 将其从 UI 消息列表和 agent 消息列表中同时移除。
 */
export const WithdrawCommand: Command = {
  name: 'withdraw',
  aliases: ['/withdraw'],
  description: '撤回上一条还没有AI响应的用户输入',
  usage: '/withdraw',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t === '/withdraw' || t === 'withdraw';
  },
  execute(_input: string, ctx): void {
    const { ui, agent } = ctx;
    const msgs = ui.messages;

    // ── 从后往前找「没有 agent 跟随的用户消息」 ──
    let lastUserIdx = -1;
    let agentSeen = false;

    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];

      if (msg.role === 'user') {
        if (lastUserIdx === -1) {
          lastUserIdx = i;
          if (!agentSeen) {
            // 这个用户之后没有 agent 消息 → 找到了
            break;
          }
          // 这个用户有 agent 回复，重置继续往前找
          lastUserIdx = -1;
          agentSeen = false;
        }
        // 遇到了更早的用户消息，停止查找
        //（lastUserIdx 为 -1 表示刚重置，继续往上找候选；
        //  不为 -1 说明上一个候选又没回复，但更近的已经确定了）
        break;
      }

      if (msg.role === 'agent') {
        agentSeen = true;
      }
    }

    if (lastUserIdx === -1) {
      ui.addSystemMessage('没有找到可撤回的用户输入');
      return;
    }

    const removedContent = msgs[lastUserIdx].content;

    // ── 从 UI 消息列表移除 ──
    msgs.splice(lastUserIdx, 1);

    // ── 从 agent 消息列表移除（按内容从后匹配） ──
    const agentMsgs = agent.getMessages();
    for (let i = agentMsgs.length - 1; i >= 0; i--) {
      const am = agentMsgs[i];
      if (am.role === 'user' && typeof am.content === 'string' && am.content === removedContent) {
        agentMsgs.splice(i, 1);
        break;
      }
    }
    agent.setMessages(agentMsgs);

    // ── 反馈 & 刷新 ──
    ui.addSystemMessage(`✅ 已撤回: ${removedContent.slice(0, 60)}${removedContent.length > 60 ? '…' : ''}`);
  },
};
