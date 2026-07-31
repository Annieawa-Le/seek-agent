/**
 * memory.ts — 上下文记忆管理工具
 *
 * 替代被弃用的 MemoryAgent 类，以工具形式让 AI 自主管理上下文：
 *   - memory_focus: 调用子 AI 将旧轮次压缩为工作梗概
 *   - memory_shorten: 将旧轮次的工具结果精简为成功状态
 */

import { tool, generateText, type ModelMessage } from 'ai';
import { z } from 'zod';
import { ToolOutput } from './tool-output';
import type { MemoryBulk } from './raw-bulk-types';
import { getModel, getSystemPrompt } from '../model-provider';

// ═════════════════════════════════════════════════════
// 辅助：识别轮次边界
// ═════════════════════════════════════════════════════

interface RoundBoundary {
  start: number;        // 在 messages 中的起始索引
  end: number;          // 在 messages 中的结束索引
  userInput: string;
  assistantTexts: string[];
  toolNames: string[];
}

/**
 * 从消息列表中按 user 消息分隔识别轮次。
 * 每条 user 消息标志一轮开始，到下一条 user 消息前结束。
 * 开头的 system 消息不计入任何轮次。
 */
function findRounds(messages: ModelMessage[]): RoundBoundary[] {
  const rounds: RoundBoundary[] = [];
  let current: RoundBoundary | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'user' && typeof msg.content === 'string') {
      if (current) {
        current.end = i - 1;
        rounds.push(current);
      }
      current = {
        start: i,
        end: i,
        userInput: msg.content,
        assistantTexts: [],
        toolNames: [],
      };
    } else if (current) {
      current.end = i;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            current.assistantTexts.push(part.text);
          } else if (part.type === 'tool-call') {
            current.toolNames.push(part.toolName);
          }
        }
      }
    }
  }

  if (current) rounds.push(current);
  return rounds;
}

/** 构造 focus 的 ToolOutput */
function focusOutput(roundsCompressed: number, msg: string, extra?: { messagesRemoved?: number; messageInserted?: number; summary?: string }): ToolOutput {
  const bulk: MemoryBulk = {
    type: 'memory',
    action: 'focus',
    roundsCompressed,
    messagesRemoved: extra?.messagesRemoved,
    messageInserted: extra?.messageInserted,
    summary: extra?.summary,
  };
  return new ToolOutput(bulk, msg);
}

/** 构造 shorten 的 ToolOutput */
function shortenOutput(roundsCompressed: number, resultsShortened: number, msg: string): ToolOutput {
  const bulk: MemoryBulk = {
    type: 'memory',
    action: 'shorten',
    roundsCompressed,
    resultsShortened,
  };
  return new ToolOutput(bulk, msg);
}

// ═════════════════════════════════════════════════════
// memory_focus — 旧轮次 → 子 AI 生成工作梗概
// ═════════════════════════════════════════════════════

export const memoryFocus = tool({
  description: [
    '将最近 keepRounds 轮以前的对话轮次压缩为工作梗概，释放上下文空间。',
    '梗概以 [Work Log] 系统消息形式保留关键信息（用户意图、AI 回答、文件修改、工具调用等）。',
    '被压缩的轮次将被从消息列表中移除，替换为一条梗概消息。',
  ].join(' '),
  inputSchema: z.object({
    keepRounds: z.number().int().min(1).default(3)
      .describe('保留的最近完整轮次数，之前的轮次将被压缩为工作梗概'),
  }),
  execute: async ({ keepRounds }, options?: { toolCallId?: string; messages?: ModelMessage[]; experimental_context?: unknown }) => {
    const messages = (options?.experimental_context as { __messages?: ModelMessage[] } | undefined)?.__messages ?? options?.messages;
    if (!messages || messages.length === 0) {
      return focusOutput(0, '📭 消息列表为空，无需压缩。');
    }

    const rounds = findRounds(messages);
    if (rounds.length <= keepRounds) {
      return focusOutput(0, `📊 当前仅有 ${rounds.length} 轮对话，少于保留轮数 ${keepRounds}，无需压缩。`);
    }

    // 要压缩的旧轮次（保留最后 keepRounds 轮）
    const oldRounds = rounds.slice(0, rounds.length - keepRounds);
    const firstIdx = oldRounds[0].start;
    const lastIdx = oldRounds[oldRounds.length - 1].end;

    // 将旧轮次消息（含最开头的 system prompt）和概括指令一起喂给子 AI
    const oldMessages = messages.slice(0, lastIdx + 1);
    const model = getModel();

    let summary: string;
    try {
      const result = await generateText({
        model,
        system: getSystemPrompt(),
        messages: [
          ...(oldMessages as any),
          { role: 'user', content: '请用第一人称"我"概括我们之前对话轮次中你做的工作、我的意图以及涉及的文件修改。这将被插入到新的工作历史中。' },
        ],
      });
      summary = result.text.trim();
    } catch {
      // 子 AI 失败时 fallback：逐轮简单截取
      const lines = oldRounds.map(r => {
        const user = r.userInput.length > 100 ? r.userInput.slice(0, 100) + '…' : r.userInput;
        return `- 用户: ${user}`;
      });
      summary = lines.join('\n');
    }

    // 替换旧轮次为一条 [Work Log] 系统消息
    messages.splice(firstIdx, lastIdx - firstIdx + 1, {
      role: 'assistant',
      content: `\n${summary}`,
    } as ModelMessage);

    const msg = [
      `✅ 已将 ${oldRounds.length} 轮旧对话压缩为工作梗概。`,
      `移除了 ${lastIdx - firstIdx + 1} 条消息，插入 1 条 [Work Log]。`,
      '',
      summary,
    ].join('\n');

    return focusOutput(oldRounds.length, msg, {
      messagesRemoved: lastIdx - firstIdx + 1,
      messageInserted: 1,
      summary,
    });
  },
});

// ═════════════════════════════════════════════════════
// memory_shorten — 旧轮次工具结果 → success
// ═════════════════════════════════════════════════════

export const memoryShorten = tool({
  description: [
    '将最近 keepRounds 轮以前的工具返回结果仅标记为 "success"，',
    '大幅减少上下文体积但保留完整的对话结构和工具调用意图信息。',
    '适合在上下文接近上限时快速释放空间。',
  ].join(' '),
  inputSchema: z.object({
    keepRounds: z.number().int().min(1).default(3)
      .describe('保留的最近完整轮次数，之前轮次中的工具结果将被精简为 "success"'),
  }),
  execute: async ({ keepRounds }, options?: { toolCallId?: string; messages?: ModelMessage[]; experimental_context?: unknown }) => {
    const messages = (options?.experimental_context as { __messages?: ModelMessage[] } | undefined)?.__messages ?? options?.messages;
    if (!messages || messages.length === 0) {
      return shortenOutput(0, 0, '📭 消息列表为空，无需处理。');
    }

    const rounds = findRounds(messages);
    if (rounds.length <= keepRounds) {
      return shortenOutput(0, 0, `📊 当前仅有 ${rounds.length} 轮对话，少于保留轮数 ${keepRounds}，无需处理。`);
    }

    // 旧轮次的索引集合
    const oldRounds = rounds.slice(0, rounds.length - keepRounds);
    const oldIndices = new Set<number>();
    for (const r of oldRounds) {
      for (let i = r.start; i <= r.end; i++) {
        oldIndices.add(i);
      }
    }

    let shortenedCount = 0;

    for (let i = 0; i < messages.length; i++) {
      if (!oldIndices.has(i)) continue;
      const msg = messages[i];
      if (msg.role !== 'tool') continue;

      if (Array.isArray(msg.content)) {
        const newContent = msg.content.map((part: any) => {
          if (part.type === 'tool-result') {
            shortenedCount++;
            return {
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: { type: 'text', value: 'success' },
            };
          }
          return part;
        });
        (messages[i] as any) = { ...msg, content: newContent };
      } else if (typeof msg.content === 'string') {
        shortenedCount++;
        (messages[i] as any) = { ...msg, content: 'success' };
      }
    }

    const msg = [
      `✅ 已将 ${oldRounds.length} 轮旧对话中的 ${shortenedCount} 个工具返回结果精简为 "success"。`,
      shortenedCount > 0
        ? `估计减少约 ${shortenedCount * 300}+ 字符的上下文占用。`
        : '（未发现需要精简的工具返回结果。）',
    ].join('\n');

    return shortenOutput(oldRounds.length, shortenedCount, msg);
  },
});



// ═════════════════════════════════════════════════════
// 对话记忆 — 双层记忆（工作记忆 + 长期记忆）
// 借鉴 shards 架构：记忆由模型自主维护，代码只负责存储与检索
// ═════════════════════════════════════════════════════

import { workingMemory, longTermMemory } from './memory-core';
import type { WorkingMemoryItem } from './memory-core';

/** 构造对话记忆的 ToolOutput */
function memoryOutput(action: MemoryBulk['action'], bulk: Partial<MemoryBulk> & { msg: string }): ToolOutput {
  const { msg, ...rest } = bulk;
  const b: MemoryBulk = { type: 'memory', action, ...rest };
  return new ToolOutput(b, msg);
}

/** 将权重转为人类可读描述 */
function weightLabel(weight: number): string {
  if (weight >= 3) return '重要';
  if (weight >= 1) return '普通';
  return '瞬时';
}

/** 格式化工作记忆列表（供注入与展示） */
export function formatWorkingMemory(items: WorkingMemoryItem[], withId = true): string {
  if (items.length === 0) return '（空）';
  return items.map((it) => {
    const id = withId ? `[${it.id}] ` : '';
    return `${id}(w:${it.weight.toFixed(1)}, ${weightLabel(it.weight)}) ${it.content}`;
  }).join('\n');
}

/**
 * memory_add — 新增工作记忆
 * 权重语义：瞬时闲聊 0.1-0.5 / 普通话题 1.0-2.0 / 重要待办 3.0-5.0
 */
export const memoryAdd = tool({
  description: [
    '将当前对话的重要状态写入「工作记忆」（短期记忆，跨轮次保留，重启后仍存在）。',
    '适合记录：进行中的任务焦点、等待外部确认的事项、用户明确表达过的偏好、当前上下文中的重要约束。',
    '权重 weight 决定记忆存活期：瞬时闲聊/玩梗 0.1-0.5，普通话题 1.0-2.0，重要待办/高优先级 3.0-5.0。',
    '不需要频繁删除旧记忆，低权重记忆会被系统按 (最近访问/权重) 自动淘汰。',
    '内容应去语境化：写成独立可读的陈述句，避免人称代词（如“他说”“这个”）和时间副词。',
  ].join(' '),
  inputSchema: z.object({
    content: z.string().describe('去语境化的状态描述，如“正在实现 agent 记忆系统，工作记忆用 WeightedLRU 淘汰”'),
    weight: z.number().default(1.0).describe('权重 0.1-5.0，默认 1.0（普通话题）'),
  }),
  execute: async ({ content, weight }) => {
    const item = workingMemory.add(content, weight);
    const msg = `✅ 已加入工作记忆 [${item.id}]（权重 ${item.weight}）：${content}`;
    return memoryOutput('add', { itemId: item.id, weight: item.weight, content, itemCount: workingMemory.size, msg });
  },
});

/** memory_update — 更新工作记忆的内容或权重 */
export const memoryUpdate = tool({
  description: [
    '更新一条工作记忆的内容和/或权重。',
    '内容变化用 content，重要性变化用 weight；只改一项时传一项即可。',
    '任务接近完成时可降低 weight，任务升级为待办时可提高 weight。',
  ].join(' '),
  inputSchema: z.object({
    id: z.number().describe('要更新的工作记忆 id（来自 memory_list 或注入的 [工作记忆] 列表）'),
    content: z.string().optional().describe('新的内容描述'),
    weight: z.number().optional().describe('新的权重 0.1-5.0'),
  }),
  execute: async ({ id, content, weight }) => {
    const ok = workingMemory.update(id, content, weight);
    if (!ok) return memoryOutput('update', { itemId: id, error: `未找到 id=${id} 的工作记忆`, msg: `⚠ 未找到 id=${id} 的工作记忆。` });
    const item = workingMemory.get(id)!;
    const parts = [`✅ 已更新工作记忆 [${id}]`];
    if (content !== undefined) parts.push(`内容 → ${content}`);
    if (weight !== undefined) parts.push(`权重 → ${weight}`);
    return memoryOutput('update', { itemId: id, weight: item.weight, content: item.content, itemCount: workingMemory.size, msg: parts.join('，') });
  },
});

/** memory_touch — 为仍在进行的话题续命 */
export const memoryTouch = tool({
  description: [
    '当当前对话再次提及某条工作记忆但内容无需修改时，调用它刷新最近访问时间，防止该记忆被自动淘汰。',
  ].join(' '),
  inputSchema: z.object({
    id: z.number().describe('要续命的工作记忆 id'),
  }),
  execute: async ({ id }) => {
    const ok = workingMemory.touch(id);
    if (!ok) return memoryOutput('touch', { itemId: id, error: `未找到 id=${id} 的工作记忆`, msg: `⚠ 未找到 id=${id} 的工作记忆。` });
    return memoryOutput('touch', { itemId: id, itemCount: workingMemory.size, msg: `✅ 已为工作记忆 [${id}] 续命。` });
  },
});

/** memory_remove — 删除工作记忆 */
export const memoryRemove = tool({
  description: [
    '删除一条工作记忆。仅在以下情况使用：待办任务已彻底完成、或该记忆被证实完全错误继续保留会误导。',
    '普通闲聊话题不要手动删，降低 weight 让它自然淘汰即可。',
  ].join(' '),
  inputSchema: z.object({
    id: z.number().describe('要删除的工作记忆 id'),
  }),
  execute: async ({ id }) => {
    const ok = workingMemory.remove(id);
    if (!ok) return memoryOutput('remove', { itemId: id, error: `未找到 id=${id} 的工作记忆`, msg: `⚠ 未找到 id=${id} 的工作记忆。` });
    return memoryOutput('remove', { itemId: id, itemCount: workingMemory.size, msg: `✅ 已删除工作记忆 [${id}]。` });
  },
});

/** memory_list — 列出所有工作记忆 */
export const memoryList = tool({
  description: '列出当前所有工作记忆（含 id、权重、内容），按最近访问排序。',
  inputSchema: z.object({}),
  execute: async () => {
    const items = workingMemory.list();
    if (items.length === 0) {
      return memoryOutput('list', { itemCount: 0, msg: '📭 当前没有工作记忆。' });
    }
    const lines = items.map((it, i) => `${i + 1}. [${it.id}] (权重 ${it.weight}) ${it.content}`);
    const msg = `📋 工作记忆（${items.length} 条）：\n${lines.join('\n')}`;
    return memoryOutput('list', { itemCount: items.length, results: items.map((it) => ({ id: it.id, content: it.content, weight: it.weight })), msg });
  },
});

/** memory_remember — 写入长期记忆（跨会话持久知识） */
export const memoryRemember = tool({
  description: [
    '将一条跨会话仍有价值的持久知识写入「长期记忆」。',
    '适合记录：项目的规则与约定（如“测试用 Vitest”）、用户的关键偏好、重要的技术决策及原因。',
    '内容必须是独立可读的绝对陈述句，建议加前缀（规则：/事实：/偏好：/决策：）。',
    '写入时会自动向量化并做相似度去重，重复内容会跳过。',
  ].join(' '),
  inputSchema: z.object({
    content: z.string().describe('绝对陈述句，如“规则：新增功能时必须同步补充测试”'),
    source: z.string().optional().describe('来源标注，如“2024-xx 对话”或文件路径'),
  }),
  execute: async ({ content, source }) => {
    try {
      const outcome = await longTermMemory.remember(content, source);
      if (!outcome.added) {
        return memoryOutput('remember', { content, skipped: true, skipReason: outcome.reason, itemCount: longTermMemory.count, msg: `⏭ ${outcome.reason}` });
      }
      return memoryOutput('remember', { content, itemId: outcome.item!.id, itemCount: longTermMemory.count, msg: `🧠 已写入长期记忆 [${outcome.item!.id}]：${content}` });
    } catch (e: any) {
      const hint = (e?.message?.includes('EMBEDDING') || e?.message?.includes('fetch') || e?.message?.includes('11434'))
        ? '（请配置 EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL 环境变量）' : '';
      return memoryOutput('remember', { content, error: `${e?.message || e}`, msg: `❌ 写入长期记忆失败：${e?.message || e} ${hint}` });
    }
  },
});

/** memory_recall — 检索长期记忆 */
export const memoryRecall = tool({
  description: [
    '在「长期记忆」中检索与当前问题相关的持久知识（规则/事实/偏好/决策）。',
    '当对话涉及之前讨论过的规则、用户的既定偏好或历史决策时调用；',
    '也适合在新任务开始时检查是否有相关约定。向量 + 关键词混合检索，自动降级。',
  ].join(' '),
  inputSchema: z.object({
    query: z.string().describe('检索关键词或自然语言描述，如“测试规范”或“用户对数据库的偏好”'),
    topK: z.number().int().min(1).max(20).default(5).describe('返回条数，默认 5'),
  }),
  execute: async ({ query, topK }) => {
    try {
      const results = await longTermMemory.recall(query, topK);
      if (results.length === 0) {
        return memoryOutput('recall', { results: [], msg: `🔍 长期记忆中未找到与「${query}」相关的内容。` });
      }
      const lines = results.map((r, i) => `${i + 1}. ${r.content}（相似度 ${(r.score * 100).toFixed(0)}%）`);
      const msg = `🔍 长期记忆检索结果（${results.length} 条）：\n${lines.join('\n')}`;
      return memoryOutput('recall', { results: results.map((r) => ({ content: r.content, score: r.score, createdAt: new Date(r.createdAt).toISOString(), source: r.source })), msg });
    } catch (e: any) {
      return memoryOutput('recall', { error: `${e?.message || e}`, msg: `❌ 检索长期记忆失败：${e?.message || e}` });
    }
  },
});

/** memory_clear — 清空记忆（谨慎） */
export const memoryClear = tool({
  description: '清空全部工作记忆和长期记忆。危险操作，仅在用户明确要求时使用。',
  inputSchema: z.object({
    target: z.enum(['working', 'long-term', 'all']).default('all').describe('清空范围：working=工作记忆 / long-term=长期记忆 / all=全部'),
  }),
  execute: async ({ target }) => {
    const wmCount = workingMemory.size;
    const ltCount = longTermMemory.count;
    if (target === 'working' || target === 'all') workingMemory.clear();
    if (target === 'long-term' || target === 'all') longTermMemory.clear();
    const msg = `🗑 已清空${target === 'all' ? '全部记忆' : target === 'working' ? '工作记忆' : '长期记忆'}（工作 ${wmCount} 条 / 长期 ${ltCount} 条）。`;
    return memoryOutput('clear', { itemCount: target === 'all' ? 0 : (target === 'working' ? workingMemory.size : longTermMemory.count), msg });
  },
});

/** memory_stats — 记忆概览 */
export const memoryStats = tool({
  description: '查看记忆系统概览：工作记忆条数、长期记忆条数、存储位置。',
  inputSchema: z.object({}),
  execute: async () => {
    const msg = [
      '🧠 记忆系统概览：',
      `  - 工作记忆：${workingMemory.size} 条（容量 ${workingMemory.capacity}，WeightedLRU 淘汰）`,
      `  - 长期记忆：${longTermMemory.count} 条（向量 + 关键词混合检索）`,
    ].join('\n');
    return memoryOutput('stats', { itemCount: workingMemory.size, msg });
  },
});
