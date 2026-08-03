/**
 * worklog-tools.ts — Worklog 召回工具（记忆消退路径的"召回"层）
 *
 * worklog_recall：按 id 或标题关键词取归档的工作梗概（压缩产物）
 * work_recall：按 id 取归档的原始消息（被压缩前的完整对话，限制返回大小）
 */

import { tool } from 'ai';
import { z } from 'zod';
import { ToolOutput } from './tool-output';
import type { WorklogBulk } from './raw-bulk-types';
import { worklogStore } from './worklog-store';

/** work_recall 返回原文的字符上限（超出截断，避免一次召回撑爆上下文） */
const RECALL_MAX_CHARS = 8000;

export const worklogRecallTool = tool({
  description: [
    '按 Worklog id（如 W12）或标题关键词检索已归档的工作梗概。',
    '当活跃上下文中的 [Worklog] 消息被降级为归档行后，可用本工具取回完整梗概。',
  ].join(' '),
  inputSchema: z.object({
    id: z.string().describe('Worklog id（如 W12）或标题关键词'),
  }),
  execute: async ({ id }) => {
    const entry = worklogStore.get(id) ?? worklogStore.findByTitle(id);
    if (!entry) {
      const list = worklogStore.list().map((e) => `${e.id}「${e.title}」`).join('，') || '（空）';
      const msg = `❌ 未找到 Worklog「${id}」。当前归档：${list}`;
      const bulk: WorklogBulk = { type: 'worklog', action: 'recall', found: false, query: id, msg };
      return new ToolOutput(bulk, msg);
    }
    const msg = `📋 Worklog ${entry.id}「${entry.title}」（创建于 ${entry.createdAt}）：\n${entry.summary}`;
    const bulk: WorklogBulk = {
      type: 'worklog', action: 'recall', found: true, query: id,
      id: entry.id, title: entry.title, summary: entry.summary,
      msg,
    };
    return new ToolOutput(bulk, msg);
  },
});

export const workRecallTool = tool({
  description: [
    '按 Worklog id 取回归档的原始消息（被压缩前的完整对话内容）。',
    '返回内容较大时会被截断；如需更多可再调用并按 id 说明。',
  ].join(' '),
  inputSchema: z.object({
    id: z.string().describe('Worklog id，如 W12'),
  }),
  execute: async ({ id }) => {
    const entry = worklogStore.get(id);
    if (!entry) {
      const msg = `❌ 未找到 Worklog「${id}」。`;
      const bulk: WorklogBulk = { type: 'worklog', action: 'recall-original', found: false, query: id, msg };
      return new ToolOutput(bulk, msg);
    }
    const raw = JSON.stringify(entry.archivedMessages, null, 1);
    const truncated = raw.length > RECALL_MAX_CHARS;
    const text = truncated ? raw.slice(0, RECALL_MAX_CHARS) + `\n…（已截断，原文共 ${raw.length} 字符）` : raw;
    const msg = `📜 Worklog ${entry.id}「${entry.title}」原文（${raw.length} 字符）：\n${text}`;
    const bulk: WorklogBulk = {
      type: 'worklog', action: 'recall-original', found: true, query: id,
      id: entry.id, title: entry.title, size: raw.length, msg,
    };
    return new ToolOutput(bulk, msg);
  },
});
