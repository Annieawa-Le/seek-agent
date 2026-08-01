/**
 * chat-thread.ts — Manager 协作聊天渠道
 *
 * 维护 manager 与每个下属（子模型 / worker 跨会话下属）的独立对话记录，
 * 供右侧协作面板的「通讯录 + 聊天视图」消费。每条沟通（派活/提交/协作消息）
 * 都写入对应 thread，不混入主对话。
 *
 * peerType:
 *   - subagent：本会话 spawn 的子模型（a_submission 提交 / agent_task 派活）
 *   - worker：跨会话打工人（collab_send 派活 / onCollabMessage 回复）
 */

export type ChatPeerType = 'subagent' | 'worker';
export type ChatRole = 'manager' | 'peer';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  ts: number;
}

export interface ChatThread {
  peerName: string;
  peerType: ChatPeerType;
  messages: ChatMessage[];
  lastActiveAt: number;
}

/** 单条 thread 上限（防无限膨胀） */
const MAX_MESSAGES = 200;

const threads = new Map<string, ChatThread>();

/** 获取或创建 thread */
export function ensureThread(peerName: string, peerType: ChatPeerType): ChatThread {
  let t = threads.get(peerName);
  if (!t) {
    t = { peerName, peerType, messages: [], lastActiveAt: Date.now() };
    threads.set(peerName, t);
  }
  return t;
}

/** 追加一条消息（自动更新活跃时间 + 截断） */
export function appendChatMessage(
  peerName: string,
  peerType: ChatPeerType,
  role: ChatRole,
  content: string,
): void {
  const t = ensureThread(peerName, peerType);
  t.messages.push({ role, content, ts: Date.now() });
  t.lastActiveAt = Date.now();
  if (t.messages.length > MAX_MESSAGES) {
    t.messages = t.messages.slice(-MAX_MESSAGES);
  }
}

/** 全部 thread（按最近活跃倒序） */
export function getChatThreads(): ChatThread[] {
  return Array.from(threads.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function getChatThread(peerName: string): ChatThread | undefined {
  return threads.get(peerName);
}

/** 清空单个 thread */
export function clearChatThread(peerName: string): void {
  threads.delete(peerName);
}
