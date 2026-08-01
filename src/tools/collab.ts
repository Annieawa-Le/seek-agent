/**
 * collab.ts — 跨会话协作工具
 *
 * 让当前会话的 Agent 能与其他会话的 Agent 沟通：
 *   - collab_sessions: 列出所有会话（活跃 + 历史）的身份卡
 *   - collab_send: 向指定会话发送协作消息（活跃直接送达 / 未活跃返回身份卡不自动唤醒）
 *
 * 工具通过 ElectronUIBridge.requestCollab 与主进程通信，
 * 主进程负责转发、身份卡组装与回复回传。
 */

import { tool } from 'ai';
import { appendChatMessage } from '../modes/chat-thread';
import { z } from 'zod';

/** 会话身份卡 → 人类可读文本 */
function formatSessionCard(card: any): string {
  const lines = [
    `📇 ${card.name || card.sessionId || '未命名会话'}`,
    card.sessionId ? `  ID: ${card.sessionId}` : '',
    card.messageCount != null ? `  消息数: ${card.messageCount}` : '',
    card.mode?.length ? `  模式: ${card.mode.join(' + ')}` : '',
    card.mtime ? `  最近活动: ${card.mtime}` : '',
    card.preview ? `  摘要: ${card.preview.slice(0, 160)}${card.preview.length > 160 ? '…' : ''}` : '',
    card.active ? '  状态: 活跃中' : '  状态: 未活跃（历史会话，可唤醒）',
  ].filter(Boolean);
  return lines.join('\n');
}

export const collabSessionsTool = tool({
  description:
    '列出所有可协作的会话（活跃 + 历史）及其身份卡（标题/消息数/摘要/最近活动时间/状态），用于寻找与当前任务相关的会话进行跨会话协作。',
  inputSchema: z.object({}),
  execute: async (_args, ctx: any) => {
    const ui = ctx?.ui;
    if (!ui?.requestCollab) {
      return '❌ 协作功能仅在 Electron 多会话模式下可用（当前为单会话/TUI 模式）。';
    }
    const res = await ui.requestCollab('sessions', {});
    if (!res?.ok) return `❌ ${res?.error || '获取会话列表失败'}`;
    const sessions = res.data?.sessions || [];
    if (sessions.length === 0) return '当前没有可协作的会话。';
    return sessions.map((s: any) => formatSessionCard(s)).join('\n\n');
  },
});

export const collabSendTool = tool({
  description:
    '向指定会话的 Agent 发送协作消息。目标会话活跃则直接送达；不活跃则返回身份卡（不会自动唤醒完整会话）。对方回复会作为协作消息自动回到本会话。',
  inputSchema: z.object({
    sessionId: z.string().describe('目标会话 ID 或标题（来自 collab_sessions 的身份卡）'),
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
    if (d.identityCard) {
      return (
        `⏸ 会话「${d.target}」当前未活跃，未自动唤醒（身份卡优先）。\n` +
        formatSessionCard(d.identityCard) +
        '\n\n如需深度协作，请先唤醒该会话（/loadsession 加载，或让用户切换到该会话），再重新发送。'
      );
    }
    return `⚠️ 未知结果：${JSON.stringify(d)}`;
  },
});





