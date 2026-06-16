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
  'read_num_line',
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


