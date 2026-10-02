/**
 * mission.ts — 任务段（mission）上下文归档工具
 *
 * 三个核心工具构成一次「任务段」的标记与收尾：
 *   - mission-start      标记任务段起点（记录本次工具调用在消息列表中的位置）
 *   - mission-accomplish 结束任务段：把起点到本次调用之间的上下文整段裁剪出会话，
 *                        以 Worklog 形式落盘（不在会话中保留任何条目，可用 worklog_recall 召回）
 *   - mission-cancel     结束任务段标记但不裁剪（放弃本次归档）
 *
 * 与 todo 配合使用：一段独立工作开始前 mission-start（通常紧随 create_todo），
 * 工作收尾时 mission-accomplish 把这段过程移出上下文，只留一条归档回执。
 *
 * 裁剪安全性：裁剪范围起于「含 mission-start 调用的 assistant 消息」，止于
 * 「含 mission-accomplish 调用的 assistant 消息」之前一条，两端都落在消息边界上，
 * 且同一条 assistant 消息的 tool-result 都紧随其后，故不会撕裂 tool-call/tool-result 配对。
 */

import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { ToolOutput } from './tool-output';
import type { MissionBulk } from './raw-bulk-types';
import { worklogStore, type WorklogEntry } from './worklog-store';

// ── 进行中的任务段 ──
// 模块级内存状态（与 todo-state 同层）：一次只允许一个任务段，进程重启即失。
interface ActiveMission {
  /** 任务段名（归档标题来源） */
  name: string;
  /** mission-start 的 toolCallId，用于在消息列表中定位起点 */
  toolCallId: string;
  createdAt: string;
}

let activeMission: ActiveMission | null = null;

/** 工具调用上下文（agent 传 messages/toolCallId，子模型走 experimental_context） */
interface ToolContext {
  toolCallId?: string;
  messages?: ModelMessage[];
  experimental_context?: unknown;
}

/** 取出本次调用可见的消息列表（agent 传入的是 this.messages 的引用，可原地裁剪） */
function resolveMessages(options?: ToolContext): ModelMessage[] | undefined {
  const fromCtx = (options?.experimental_context as { __messages?: ModelMessage[] } | undefined)?.__messages;
  return fromCtx ?? options?.messages;
}

/** 从后往前找到「内容里含指定 toolCallId 的 tool-call」的 assistant 消息下标（找不到返回 -1） */
function findToolCallMessageIndex(messages: ModelMessage[], toolCallId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const hit = (msg.content as Array<{ type?: string; toolCallId?: string }>)
      .some((part) => part?.type === 'tool-call' && part.toolCallId === toolCallId);
    if (hit) return i;
  }
  return -1;
}

/** 构造 ToolOutput（msg 只进 AI 文本，不进结构化 bulk） */
function missionOutput(action: MissionBulk['action'], bulk: Partial<MissionBulk> & { msg: string }): ToolOutput {
  const { msg, ...rest } = bulk;
  const b: MissionBulk = { type: 'mission', action, name: '', ...rest };
  return new ToolOutput(b, msg);
}

// ═════════════════════════════════════════════════════
// mission-start — 标记任务段起点
// ═════════════════════════════════════════════════════

export const missionStart = tool({
  description: [
    '标记一个「任务段」的起点：把当前位置记为待归档边界。',
    '适合在开始一段独立工作（一项子任务、一轮调研、一次重构）之前调用，通常与 create_todo 一起使用。',
    '之后调用 mission-accomplish 时，从本次调用到它之间的全部对话（含工具调用与结果）会被裁剪出上下文，',
    '并以 Worklog 落盘（不在会话中保留条目），需要时可用 worklog_recall / work_recall 取回。',
    '同一时间只允许一个进行中的任务段；放弃时用 mission-cancel 清除标记。',
  ].join(' '),
  inputSchema: z.object({
    name: z.string().describe('任务段名称（≤20 字，将作为归档标题），如“重构 patch 定位逻辑”'),
  }),
  execute: async ({ name }, options?: ToolContext) => {
    const label = (name ?? '').trim().slice(0, 20) || '任务段';

    if (activeMission) {
      const msg = `⚠ 已有进行中的任务段「${activeMission.name}」（开始于 ${activeMission.createdAt}）。请先用 mission-accomplish 归档、或用 mission-cancel 取消，再开启新的任务段。`;
      return missionOutput('start', { name: label, error: msg, msg });
    }

    const toolCallId = options?.toolCallId;
    if (!toolCallId) {
      const msg = '⚠ 无法标记任务段起点：本次工具调用缺少 toolCallId 上下文，起点位置不可定位。';
      return missionOutput('start', { name: label, error: msg, msg });
    }

    activeMission = { name: label, toolCallId, createdAt: new Date().toISOString() };
    const msg = [
      `🚩 已标记任务段起点「${label}」。`,
      '这段工作收尾时调用 mission-accomplish(summary) 把它整段归档出上下文；若需保留则用 mission-cancel。',
    ].join('\n');
    return missionOutput('start', { name: label, msg });
  },
});

// ═════════════════════════════════════════════════════
// mission-accomplish — 收尾：裁剪区间上下文并归档落盘
// ═════════════════════════════════════════════════════

export const missionAccomplish = tool({
  description: [
    '结束当前任务段：把 mission-start 到本次调用之间的上下文整段裁剪，并归档为 Worklog（仅落盘，会话中不留条目）。',
    '参数 summary 是这段工作的提交概要 / 经验教训，将作为 Worklog 梗概保存，供 worklog_recall 取回。',
    '裁剪后这段对话不再占用上下文，只会留下本次调用的结果回执（含 Worklog id）。',
    '必须与 mission-start 成对使用；调用后该任务段标记自动清除。',
  ].join(' '),
  inputSchema: z.object({
    summary: z.string().describe('任务段概要 / 经验教训：做了什么、结论、涉及文件、遗留待办、如何取回细节'),
  }),
  execute: async ({ summary }, options?: ToolContext) => {
    if (!activeMission) {
      const msg = '⚠ 当前没有进行中的任务段：mission-accomplish 需与 mission-start 成对使用。';
      return missionOutput('accomplish', { error: msg, msg });
    }

    const mission = activeMission;
    const messages = resolveMessages(options);
    if (!messages || messages.length === 0) {
      const msg = '⚠ 拿不到消息列表，无法裁剪；任务段标记保持不变。';
      return missionOutput('accomplish', { name: mission.name, error: msg, msg });
    }

    // 起点：含 mission-start 调用的 assistant 消息
    const startIdx = findToolCallMessageIndex(messages, mission.toolCallId);
    if (startIdx === -1) {
      activeMission = null;
      const msg = `⚠ 任务段「${mission.name}」的起点消息已不在上下文中（可能已被记忆消退压缩归档），本次不裁剪；标记已清除。`;
      return missionOutput('accomplish', { name: mission.name, messagesRemoved: 0, error: msg, msg });
    }

    // 终点：含本次 mission-accomplish 调用的 assistant 消息（定位不到时退回消息列表末尾）
    const endIdx = options?.toolCallId
      ? findToolCallMessageIndex(messages, options.toolCallId)
      : -1;
    const lastIdx = (endIdx === -1 ? messages.length : endIdx) - 1;

    const removed = lastIdx >= startIdx ? messages.slice(startIdx, lastIdx + 1) : [];
    activeMission = null;

    if (removed.length === 0) {
      const msg = `🚩 任务段「${mission.name}」区间内没有可归档的消息，本次未裁剪；标记已清除。`;
      return missionOutput('accomplish', { name: mission.name, messagesRemoved: 0, msg });
    }

    const title = mission.name.slice(0, 20) || '任务段';
    const id = worklogStore.nextId();
    const entry: WorklogEntry = {
      id,
      title,
      summary: (summary ?? '').trim() || '（未提供概要）',
      archivedMessages: removed,
      createdAt: new Date().toISOString(),
    };
    worklogStore.add(entry);
    // 整段移出活跃上下文（不做任何替换 —— 会话中不留归档条目）
    messages.splice(startIdx, removed.length);

    const msg = [
      `📦 任务段「${title}」已归档为 ${id}：${removed.length} 条消息移出上下文（仅落盘，会话中无条目）。`,
      `需要时用 worklog_recall ${id} 取梗概、work_recall ${id} 取原文。`,
    ].join('\n');
    return missionOutput('accomplish', {
      name: title, title, worklogId: id, messagesRemoved: removed.length, summary: entry.summary, msg,
    });
  },
});

// ═════════════════════════════════════════════════════
// mission-cancel — 结束标记但不裁剪
// ═════════════════════════════════════════════════════

export const missionCancel = tool({
  description: [
    '取消当前进行中的任务段（结束 mission-start 的标记），但不裁剪任何上下文。',
    '适用于任务提前中止、或发现这段工作仍需留在上下文中的情况。',
  ].join(' '),
  inputSchema: z.object({}),
  execute: async () => {
    if (!activeMission) {
      const msg = '⚠ 当前没有进行中的任务段，无需取消。';
      return missionOutput('cancel', { error: msg, msg });
    }
    const mission = activeMission;
    activeMission = null;
    const msg = `🚩 已取消任务段「${mission.name}」的标记，上下文保持原样（未裁剪）。`;
    return missionOutput('cancel', { name: mission.name, msg });
  },
});
