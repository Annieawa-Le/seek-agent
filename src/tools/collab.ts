/**
 * collab.ts — 跨会话协作工具
 *
 * 让当前会话的 Agent 能与其他会话的 Agent 沟通：
 *   - collab_send: 向指定会话发送协作消息（活跃直接送达；不活跃不自动唤醒）
 *
 * 工具通过 ElectronUIBridge.requestCollab 与主进程通信，
 * 主进程负责转发与回复回传。
 */

import { tool } from 'ai';
import { appendChatMessage } from '../modes/chat-thread';
import { z } from 'zod';

export const collabSendTool = tool({
  description:
    '向指定会话的 Agent 发送协作消息。目标会话活跃则直接送达；不活跃则不会自动唤醒（需先通过 /loadsession 或切换到该会话唤醒）。对方回复会作为协作消息自动回到本会话。',
  inputSchema: z.object({
    sessionId: z.string().describe('目标会话 ID 或标题（来自左侧会话列表）'),
    message: z.string().describe('协作消息内容'),
  }),
  execute: async ({ sessionId, message }, ctx: any) => {
    const ui = ctx?.ui;
    if (!ui?.requestCollab) {
      return '❌ 协作功能仅在 Electron 多会话模式下可用（当前为单会话/TUI 模式）。';
    }
    if (!sessionId || !message.trim()) return '❌ 需要提供 sessionId 和 message。';
    const res = await ui.requestCollab('send', { to: sessionId, content: message.trim() });
    if (!res?.ok) return `❌ ${res?.error || '发送失败'}`;
    const d = res.data || {};
    // 发送记录写入协作聊天 thread（manager 角色；worker 下属场景）
    appendChatMessage(String(d.target || sessionId), 'worker', 'manager', message.trim());
    if (d.delivered) {
      return `✅ 协作消息已送达会话「${d.target}」。对方回复会自动回到本会话。`;
    }
    if (d.active === false) {
      return `⏸ 会话「${d.target}」当前未活跃，未自动唤醒。\n如需深度协作，请先唤醒该会话（/loadsession 加载，或让用户切换到该会话），再重新发送。`;
    }
    return `⚠️ 未知结果：${JSON.stringify(d)}`;
  },
});

