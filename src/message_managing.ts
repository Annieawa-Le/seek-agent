/**
 * message_managing.ts — 上下文管理器
 *
 * 职责：
 *   在每轮消息传给模型之前，对消息列表进行预处理，
 *   为后续的「上下文布置」提供统一的入口。
 *
 * 使用方式（在 index.ts 中）：
 *   import { createMessageHook } from './message_managing';
 *   agent.messageHook = createMessageHook();
 */

import { ModelMessage, ToolCallPart, ToolResultPart } from 'ai';
import { workingMemory } from './tools/memory-core';
import { formatWorkingMemory } from './tools/memory';
import { sanitizeToolInput } from './tools';
import { MessageHook } from './agent';

// ═════════════════════════════════════════════════════
// 配置选项（后续可扩展）
// ═════════════════════════════════════════════════════
export interface ContextManagerOptions {
  /** 保留的最大消息轮数（0 = 不做截断） */
  maxRounds?: number;
  /** 是否在每条 user 消息前注入上下文摘要 */
  enableContextSummary?: boolean;
}

// ═════════════════════════════════════════════════════
// 内部状态（可用来累积跨轮次的上下文信息）
// ═════════════════════════════════════════════════════
interface ContextState {
  /** 对话摘要 / 持久化上下文，后续可在此累积 */
  accumulatedContext: string;
}

// ── 读取类工具列表（不会修改文件系统） ──
const READ_TOOLS = new Set([
  'read_file',
  'scan_file',
  'scanning_function',
  'scanning_class',
  'read_package',
]);
const LINE_READ_TOOLS = new Set([
  'read_lines',
]);
const SEARCH_TOOLS = new Set([
  'search_all_file',
  'search_sub_file',
  'search_directory',
  'search_content',
]);

/**
 * 从工具调用中提取去重用的标识 key。
 * - 文件读取类：read:{filePath}
 * - 行读取类：read_lines:{filePath}:{startLine}:{endLine}
 * - 搜索类：search:{toolName}:{序列化参数}
 */
function getToolCallKey(toolName: string, input: Record<string, unknown>): string | null {
  if (READ_TOOLS.has(toolName) && typeof input.filePath === 'string') {
    return `read:${input.filePath}`;
  }
  if (LINE_READ_TOOLS.has(toolName) && typeof input.filePath === 'string'
      && typeof input.startLine === 'number' && typeof input.endLine === 'number') {
    return `${toolName}:${input.filePath}:${input.startLine}:${input.endLine}`;
  }
  if (SEARCH_TOOLS.has(toolName)) {
    return `search:${toolName}:${JSON.stringify(input)}`;
  }
  return null;
}
/**
 * 修复孤立的 tool-call / tool-result。
 *
 * 上游（provider）要求每个 tool-call 都有配对的 tool-result，反之亦然；
 * 任一侧缺失都会导致整条请求被 400 拒绝，而且畸形消息留在历史里会让该会话永久报废。
 * 两类修复：
 *   - 孤立 tool-call（assistant 有 call，无 result）：在紧随其后的 tool 消息里补一条
 *     占位 result，明确告知模型「该调用未返回结果（已中断）」。
 *   - 孤立 tool-result（有 result，无 call）：直接从消息中剔除。
 *
 * 该函数不修改入参数组（构造新数组返回），可安全地在 hook 中调用。
 */
function repairOrphanToolParts(messages: ModelMessage[]): ModelMessage[] {
  // 收集所有 tool-call id 与 tool-result id
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'tool-call') callIds.add((part as ToolCallPart).toolCallId);
      else if (part.type === 'tool-result') resultIds.add((part as ToolResultPart).toolCallId);
    }
  }

  const missingResults = new Set([...callIds].filter((id) => !resultIds.has(id)));
  const orphanResults = new Set([...resultIds].filter((id) => !callIds.has(id)));
  if (missingResults.size === 0 && orphanResults.size === 0) return messages;

  console.warn(
    `⚠ 检测到孤立的工具消息：缺失 result ${missingResults.size} 个、多余 result ${orphanResults.size} 个 —— 已自动修复`,
  );

  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) { out.push(msg); continue; }

    // 剔除孤立 tool-result
    const keptParts = msg.content.filter(
      (p) => !(p.type === 'tool-result' && orphanResults.has((p as ToolResultPart).toolCallId)),
    );
    if (keptParts.length > 0) out.push(keptParts.length === msg.content.length ? msg : ({ ...msg, content: keptParts } as ModelMessage));

    // assistant 消息后，为其中缺失结果的 tool-call 补一条占位 result
    if (msg.role === 'assistant') {
      const need = keptParts.filter(
        (p) => p.type === 'tool-call' && missingResults.has((p as ToolCallPart).toolCallId),
      ) as ToolCallPart[];
      if (need.length > 0) {
        out.push({
          role: 'tool',
          content: need.map((tc) => ({
            type: 'tool-result' as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: { type: 'text' as const, value: '（该工具调用未返回结果，可能被中断）' },
          })),
        } as ModelMessage);
      }
    }
  }
  return out;
}

/**
 * 创建一个 MessageHook 函数，用于在每轮消息传给模型前进行预处理。
 *
 * 预处理逻辑：
 *   检测读取类工具调用（read_file / scan_file / search_* 等），
 *   同一文件/同一搜索参数如果被多次读取，只保留最新一次的结果，
 *   移除旧的结果及对应的 tool-call 消息，避免上下文被冗余内容撑爆。
 *
 * @param options 配置选项
 * @returns MessageHook 函数，可直接赋值给 agent.messageHook
 */
export function createMessageHook(options?: ContextManagerOptions): MessageHook {
  const opts: ContextManagerOptions = {
    maxRounds: 0,
    enableContextSummary: false,
    ...options,
  };

  // 内部状态（闭包持有，跨多次调用保持）
  const state: ContextState = {
    accumulatedContext: '',
  };

  // ── 返回的 hook 函数，每次调用 AI 前都会执行 ──
  return (messages: ModelMessage[]): ModelMessage[] => {
    // ──────── 前置步：修复孤立 tool-call / tool-result（防止会话 400 报废） ────────
    // 无论根因如何，只要 assistant 里有一条 tool-call 找不到配对的 tool-result，
    // provider 就会以 400 invalid_request_error 拒绝整个请求，且重试无用（消息畸形依旧）。
    // 这里在发请求前补齐缺失的 tool-result，让已损坏的会话能够自愈。
    messages = repairOrphanToolParts(messages);

    // ──────── 第零步：注入工作记忆（双层记忆的短期层） ────────
    // 工作记忆有内容时注入为一条 [工作记忆] 标记的 user 消息；
    // 已注入过则原地更新内容，让模型在调用 memory_* 工具后能看到最新状态。
    // 只注入最近访问的 top 10，避免历史决策档案淹没当前焦点
    const wmItems = workingMemory.list().slice(0, 10);
    if (wmItems.length > 0) {
      const wmContent = [
        '[工作记忆] 当前对话焦点与任务状态（可通过 memory_add / memory_update / memory_touch / memory_remove 维护，权重越高存活越久）：',
        formatWorkingMemory(wmItems),
      ].join('\n');
      const wmIdx = messages.findIndex((m) =>
        m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[工作记忆]'),
      );
      if (wmIdx !== -1) {
        messages = messages.map((m, i) =>
          (i === wmIdx ? ({ ...m, content: wmContent } as ModelMessage) : m),
        );
      } else {
        messages = [{ role: 'user', content: wmContent } as ModelMessage, ...messages] as ModelMessage[];
      }
    }

    // ──────── 第一步：扫描所有 assistant 消息，收集读取类工具调用 ────────
    // key -> { toolCallId, msgIndex }[]
    const readCallsMap = new Map<string, { toolCallId: string; msgIndex: number }[]>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool-call') {
            const tcPart = part as ToolCallPart;
            const key = getToolCallKey(tcPart.toolName, tcPart.input as Record<string, unknown>);
            if (key) {
              if (!readCallsMap.has(key)) {
                readCallsMap.set(key, []);
              }
              readCallsMap.get(key)!.push({ toolCallId: tcPart.toolCallId, msgIndex: i });
            }
          }
        }
      }
    }

    // ──────── 第二步：标记需要移除的 toolCallId（保留每组最后一次） ────────
    const toRemove = new Set<string>();
    for (const [, calls] of readCallsMap) {
      if (calls.length > 1) {
        // 保留最后一个，前面的都移除
        for (let j = 0; j < calls.length - 1; j++) {
          toRemove.add(calls[j].toolCallId);
        }
      }
    }

    if (toRemove.size === 0) {
      // ── 没有冗余读取，走原有占位逻辑（透传） ──
      if (opts.enableContextSummary && state.accumulatedContext) {
        // 后续：将 accumulatedContext 作为一条 system 或 user 消息插入
      }
      if (opts.maxRounds && opts.maxRounds > 0) {
        // 后续：只保留最近 N 轮的消息
      }
      return messages;
    }
    // ──────── 第四步：修复 tool-call 中 string 类型的 input ────────
    // AI SDK 在 LLM 生成非法 JSON 工具参数时，会回退为原始字符串。
    // 这个 string 存入消息后，下一轮发给 provider 会崩溃（期望 object 收到 string）。
    // 此处兜底修复，确保所有 tool-call 的 input 都是 object。
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool-call') {
            const tcPart = part as ToolCallPart;
            if (typeof tcPart.input === 'string') {
              tcPart.input = sanitizeToolInput(tcPart.input);
            }
          }
        }
      }
    }
    // ──────── 第三步：过滤消息，移除被标记的 tool-call 和 tool-result ────────
    return messages
      .map((msg) => {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          const filtered = msg.content.filter((part) => {
            if (part.type === 'tool-call') {
              return !toRemove.has((part as ToolCallPart).toolCallId);
            }
            return true;
          });
          if (filtered.length === 0) return null; // 整条消息移除
          return { ...msg, content: filtered };
        }

        if (msg.role === 'tool' && Array.isArray(msg.content)) {
          const filtered = msg.content.filter((part) => {
            if (part.type === 'tool-result') {
              return !toRemove.has((part as ToolResultPart).toolCallId);
            }
            return true;
          });
          if (filtered.length === 0) return null; // 整条消息移除
          return { ...msg, content: filtered };
        }

        return msg;
      })
      .filter(Boolean) as ModelMessage[];
  };
}








