/**
 * subagent-stream.ts — 子 Agent 消息流（便条窗体数据源）
 *
 * 以「消息」的颗粒度记录每个子 Agent（clone/mission）执行过程中产生的
 * 完整消息流：任务（user）、assistant 文本、工具调用、工具结果、最终提交。
 * 供 WebUI 右侧协作面板的「子 Agent 便条窗体」实时渲染，追踪工作进度；
 * 也可将整个消息流导出为 json-session 文件（未完成的工具调用补 toolResult）。
 *
 * 与 chat-thread（manager↔peer 的对话记录）互补：
 *   - chat-thread：派活/提交的概要对话
 *   - subagent-stream：子 Agent 内部逐条消息（含工具调用细节）
 */

export type SubagentStreamRole = 'user' | 'assistant' | 'tool' | 'system';

export interface SubagentStreamMsg {
  role: SubagentStreamRole;
  /** 文本内容（user 任务 / assistant 文本 / system 状态） */
  content: string;
  /** 工具调用/结果：工具名 */
  toolName?: string;
  /** 工具调用 ID（用于配对 tool-call 与 tool-result、导出 session 文件） */
  toolCallId?: string;
  /** 工具调用参数（原始 JSON） */
  toolInput?: Record<string, unknown>;
  /** 工具结果完整输出 */
  fullOutput?: string;
  /** 消息时间戳 */
  ts: number;
}

/** 单条流上限（防无限膨胀，超出截断最早消息） */
const MAX_STREAM_MESSAGES = 500;

const streams = new Map<string, SubagentStreamMsg[]>();

/** 追加一条子 Agent 流消息（自动截断） */
export function recordStreamMessage(name: string, msg: Omit<SubagentStreamMsg, 'ts'>): void {
  let list = streams.get(name);
  if (!list) {
    list = [];
    streams.set(name, list);
  }
  list.push({ ...msg, ts: Date.now() });
  if (list.length > MAX_STREAM_MESSAGES) {
    streams.set(name, list.slice(-MAX_STREAM_MESSAGES));
  }
}

/** 追加一条 user（任务）消息 */
export function recordTask(name: string, task: string): void {
  recordStreamMessage(name, { role: 'user', content: task });
}

/** 追加一条 assistant 文本消息 */
export function recordAssistant(name: string, text: string): void {
  if (!text.trim()) return;
  recordStreamMessage(name, { role: 'assistant', content: text });
}

/** 追加一条工具调用消息 */
export function recordToolCall(
  name: string,
  toolName: string,
  toolCallId: string,
  toolInput: Record<string, unknown>,
): void {
  recordStreamMessage(name, { role: 'tool', content: '', toolName, toolCallId, toolInput });
}

/** 追加一条工具结果消息 */
export function recordToolResult(name: string, toolName: string, toolCallId: string, output: string): void {
  recordStreamMessage(name, { role: 'tool', content: '', toolName, toolCallId, fullOutput: output });
}

/** 追加一条 system 状态消息（提交/错误/停止） */
export function recordSystem(name: string, content: string): void {
  recordStreamMessage(name, { role: 'system', content });
}

/** 读取某个子 Agent 的完整消息流 */
export function getSubagentStream(name: string): SubagentStreamMsg[] {
  return streams.get(name) ?? [];
}

/** 全部消息流（peerName → 消息列表，供 sidebar:data 推送） */
export function getSubagentStreams(): Record<string, SubagentStreamMsg[]> {
  return Object.fromEntries(streams);
}

/** 清空某个子 Agent 的消息流 */
export function clearSubagentStream(name: string): void {
  streams.delete(name);
}
