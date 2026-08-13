/**
 * subagent-context-store.ts — 子 Agent 上下文本地化存储
 *
 * 把每个子 Agent 的对话历史（childMessages）持久化到对应主会话文件夹：
 *   {workspace}/sessions/{sessionId}/subagent/{name}.json
 *
 * 子 Agent 派活结束（提交 / 中断 / 出错）后保存上下文；再次派活时加载作为初始
 * 上下文，实现「上下文延续」——子 Agent 不必每次从零开始理解任务与背景。
 *
 * 与 subagent-stream（便条窗体的内存消息流）互补：这里保存的是喂给 LLM 的
 * ModelMessage[]（含 tool-call/tool-result 闭环），可直接续接下一轮派活。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionsRoot } from '../workdir';

/** 持久化上下文（瘦身后的对话历史 + 子 Agent 身份信息） */
export interface SubagentPersistedContext {
  name: string;
  mode: string;
  tools: string[];
  systemPrompt?: string;
  context?: string;
  requirement?: string;
  maxRounds?: number;
  createdAt?: number;
  /** 对话历史（ModelMessage[]，超大 tool-result 已截断） */
  messages: unknown[];
  updatedAt: string;
}

/** 每条 tool-result 文本的最大保留长度（控制 session 文件体积） */
const MAX_TOOL_RESULT_LEN = 2000;
/** 持久化消息上限（超出截断最早消息，防止多轮延续后无限膨胀） */
const MAX_MESSAGES = 120;

function safeName(id: string): string {
  return (id || 'default').replace(/[\\/:*?"<>|]/g, '_');
}

/** 瘦身：截断超大 tool-result、限制消息条数 */
export function slimMessages(msgs: unknown[]): unknown[] {
  const slim = msgs.map((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role === 'tool' && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as any[]).map((p) => {
          if (p?.type === 'tool-result' && p.output?.type === 'text' && typeof p.output.value === 'string') {
            const v = p.output.value;
            if (v.length > MAX_TOOL_RESULT_LEN) {
              return { ...p, output: { type: 'text', value: `${v.slice(0, MAX_TOOL_RESULT_LEN)}\n…[工具结果过长已截断]` } };
            }
          }
          return p;
        }),
      };
    }
    return msg;
  });
  return slim.length > MAX_MESSAGES ? slim.slice(-MAX_MESSAGES) : slim;
}

class SubagentContextStore {
  private sessionId = '';

  /** agent 启动/切换会话时调用，切换后读写落点自动跟随 */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** 某个子 Agent 上下文的落盘路径（sid 缺省取当前会话；子 Agent 后台执行按 owner 分区写） */
  private filePath(name: string, sid?: string): string {
    const s = sid || this.sessionId;
    return path.join(
      getSessionsRoot(),
      'sessions',
      safeName(s),
      'subagent',
      `${safeName(name)}.json`,
    );
  }

  /** 保存子 Agent 上下文（自动建目录；sid 缺省取当前会话） */
  save(name: string, ctx: Omit<SubagentPersistedContext, 'updatedAt'>, sid?: string): void {
    try {
      const fp = this.filePath(name, sid);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify({ ...ctx, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
    } catch {
      // 落盘失败不影响主流程（内存态继续）
    }
  }

  /** 加载子 Agent 上下文；不存在或损坏返回 undefined（sid 缺省取当前会话） */
  load(name: string, sid?: string): SubagentPersistedContext | undefined {
    try {
      const fp = this.filePath(name, sid);
      if (!fs.existsSync(fp)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as SubagentPersistedContext;
      if (!parsed || typeof parsed.name !== 'string') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** 删除子 Agent 上下文（spawn 同名重建 / fire 销毁时调用；sid 缺省取当前会话） */
  remove(name: string, sid?: string): void {
    try {
      const fp = this.filePath(name, sid);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
      // 删除失败忽略
    }
  }

  /** 列出当前会话下所有已持久化的子 Agent 名 */
  list(): string[] {
    try {
      const dir = path.join(getSessionsRoot(), 'sessions', safeName(this.sessionId), 'subagent');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}

/** 全局单例（Electron 每会话一个 agent 进程，进程内单例安全） */
export const subagentContextStore = new SubagentContextStore();


/**
 * 清理持久化消息：为未闭环的 tool-call（中断/a_submission 可能留下没有
 * tool-result 的调用，直接续接会被 AI SDK 本地 MissingToolResultsError 拒绝）
 * 构造 ToolResult 占位补上——不截断 tool-call，保留上下文信息；
 * 同时移除孤立的 tool-result（没有对应 tool-call 的 result）。
 */
export function cleanPersistedMessages(msgs: unknown[]): unknown[] {
  // 第一遍：收集已有 tool-result 的 toolCallId
  const toolResultIds = new Set<string>();
  for (const m of msgs) {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role === 'tool' && Array.isArray(msg.content)) {
      for (const p of msg.content as any[]) {
        if (p?.type === 'tool-result' && typeof p.toolCallId === 'string') toolResultIds.add(p.toolCallId);
      }
    }
  }

  const cleaned: unknown[] = [];
  const toolCallIds = new Set<string>();
  for (const m of msgs) {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      const parts = (msg.content as any[]).map((p) => {
        if (p?.type === 'tool-call' && typeof p.toolCallId === 'string') toolCallIds.add(p.toolCallId);
        return p;
      });
      // 未闭环 tool-call：保留原样，在其后构造 ToolResult 占位（保证配对完整，不丢上下文）
      const missing = (msg.content as any[]).filter((p) =>
        p?.type === 'tool-call' && typeof p.toolCallId === 'string' && !toolResultIds.has(p.toolCallId),
      );
      cleaned.push({ ...msg, content: parts });
      for (const mm of missing) {
        cleaned.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: mm.toolCallId,
            toolName: typeof mm.toolName === 'string' ? mm.toolName : '',
            output: { type: 'text', value: `[未完成] 工具调用被中断（${typeof mm.toolName === 'string' ? mm.toolName : '未知工具'}），无结果返回；如需结果请重新调用。` },
          }],
        });
      }
      continue;
    }
    if (msg?.role === 'tool' && Array.isArray(msg.content)) {
      // 移除孤立 tool-result（无对应 tool-call 的 result，避免模型困惑）
      const parts = (msg.content as any[]).filter((p) => {
        if (p?.type === 'tool-result' && typeof p.toolCallId === 'string' && !toolCallIds.has(p.toolCallId)) return false;
        return true;
      });
      if (parts.length > 0) cleaned.push({ ...msg, content: parts });
      continue;
    }
    cleaned.push(msg);
  }
  return cleaned;
}



