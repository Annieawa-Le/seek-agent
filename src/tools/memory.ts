/**
 * memory.ts — 上下文记忆管理工具
 *
 * 替代被弃用的 MemoryAgent 类，以工具形式让 AI 自主管理上下文：
 *   - memory_focus: 调用子 AI 将旧轮次压缩为工作梗概
 *   - memory_shorten: 将旧轮次的工具结果精简为成功状态
 */

import { tool, generateText, type ModelMessage } from 'ai';
import { z } from 'zod';
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
      return '📭 消息列表为空，无需压缩。';
    }

    const rounds = findRounds(messages);
    if (rounds.length <= keepRounds) {
      return `📊 当前仅有 ${rounds.length} 轮对话，少于保留轮数 ${keepRounds}，无需压缩。`;
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

    return [
      `✅ 已将 ${oldRounds.length} 轮旧对话压缩为工作梗概。`,
      `移除了 ${lastIdx - firstIdx + 1} 条消息，插入 1 条 [Work Log]。`,
      '',
      summary,
    ].join('\n');
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
      return '📭 消息列表为空，无需处理。';
    }

    const rounds = findRounds(messages);
    if (rounds.length <= keepRounds) {
      return `📊 当前仅有 ${rounds.length} 轮对话，少于保留轮数 ${keepRounds}，无需处理。`;
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

    return [
      `✅ 已将 ${oldRounds.length} 轮旧对话中的 ${shortenedCount} 个工具返回结果精简为 "success"。`,
      shortenedCount > 0
        ? `估计减少约 ${shortenedCount * 300}+ 字符的上下文占用。`
        : '（未发现需要精简的工具返回结果。）',
    ].join('\n');
  },
});



