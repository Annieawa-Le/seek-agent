/**
 * subagent-note-utils.ts — 子 Agent 便条窗体的纯转换函数
 *
 * 与 React 解耦（可被脚本直接 import 测试）：
 *   - toNoteMessages：子 Agent 消息流 → 主消息区一致的 DisplayMessage
 *   - buildSessionFile：消息流 → json-session 文件（未完成工具调用补 toolResult）
 */
import type { SubagentStreamMsg, ToolHistoryEntry } from '../types/index.ts';
import type { DisplayMessage } from '../hooks/useMessages.ts';

/** 工具调用 → ToolHistoryEntry 的参数展示文本 */
function formatCallEntry(toolName: string, toolInput?: Record<string, unknown>): string {
  if (!toolInput || Object.keys(toolInput).length === 0) return toolName;
  const argsStr = Object.entries(toolInput)
    .map(([k, v]) => {
      const vs = typeof v === 'string' ? v : JSON.stringify(v);
      return vs.length > 60 ? `${k}=${vs.slice(0, 60)}…` : `${k}=${vs}`;
    })
    .join(', ');
  return `${toolName}(${argsStr})`;
}

/**
 * 把子 Agent 消息流转换为与主消息区一致的 DisplayMessage 列表：
 * assistant 文本 → agent 气泡，工具调用/结果并入其 toolHistory（与主消息区相同）。
 */
export function toNoteMessages(stream: SubagentStreamMsg[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let lastAgentIdx = -1;
  let id = 0;

  for (const m of stream) {
    const nid = () => ++id;
    if (m.role === 'user') {
      out.push({ id: nid(), role: 'user', content: m.content, createdAt: m.ts });
      lastAgentIdx = -1;
    } else if (m.role === 'system') {
      out.push({ id: nid(), role: 'system', content: m.content, createdAt: m.ts });
      lastAgentIdx = -1;
    } else if (m.role === 'assistant') {
      out.push({ id: nid(), role: 'agent', content: m.content, createdAt: m.ts, toolHistory: [] });
      lastAgentIdx = out.length - 1;
    } else if (m.role === 'tool') {
      if (m.fullOutput == null) {
        // 工具调用：并入最后一个 agent 气泡的工具时间线
        const entry: ToolHistoryEntry = {
          paramsHtml: formatCallEntry(m.toolName || '', m.toolInput),
          toolName: m.toolName || '',
          args: m.toolInput,
          resultHtml: null,
          fullOutput: null,
        };
        if (lastAgentIdx >= 0) {
          const agent = out[lastAgentIdx];
          const history = agent.toolHistory ? [...agent.toolHistory] : [];
          history.push(entry);
          out[lastAgentIdx] = { ...agent, toolHistory: history, toolHistoryIndex: history.length - 1 };
        } else {
          out.push({ id: nid(), role: 'agent', content: '', createdAt: m.ts, toolHistory: [entry], toolHistoryIndex: 0 });
          lastAgentIdx = out.length - 1;
        }
      } else {
        // 工具结果：回填最后一个尚未完成的工具调用
        if (lastAgentIdx >= 0) {
          const agent = out[lastAgentIdx];
          const history = agent.toolHistory ? [...agent.toolHistory] : [];
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].fullOutput === null && history[i].resultHtml === null) {
              history[i] = { ...history[i], fullOutput: m.fullOutput, resultHtml: null };
              break;
            }
          }
          out[lastAgentIdx] = { ...agent, toolHistory: history };
        }
      }
    }
  }
  return out;
}

/** session 文件里的 ModelMessage 简化结构（与 agent 进程 /loadsession 兼容） */
interface SessionModelMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

/**
 * 把子 Agent 消息流组装为 json-session 文件内容。
 * 未完成的工具调用（有 tool-call 无 tool-result）补充一条 toolResult。
 */
export function buildSessionFile(peer: string, stream: SubagentStreamMsg[]): Record<string, unknown> {
  const msgs: SessionModelMessage[] = [];
  let pendingText = ''; // 最近 assistant 文本（与后续工具调用组成一条 assistant parts 消息）
  let pendingCalls: Array<{ toolCallId: string; toolName: string; toolInput: Record<string, unknown> }> = [];

  const flushAssistant = () => {
    if (pendingText || pendingCalls.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (pendingText) parts.push({ type: 'text', text: pendingText });
      for (const c of pendingCalls) {
        parts.push({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.toolInput });
      }
      msgs.push({ role: 'assistant', content: parts });
      pendingText = '';
      pendingCalls = [];
    }
  };

  const toolResults = new Map<string, string>(); // toolCallId → output

  for (const m of stream) {
    if (m.role === 'user') {
      flushAssistant();
      msgs.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      // 缓存文本：等本回合工具调用一起组成 parts
      pendingText = pendingText ? `${pendingText}\n${m.content}` : m.content;
    } else if (m.role === 'tool') {
      if (m.fullOutput == null && m.toolCallId) {
        // 工具调用：先记入 pending，等结果
        pendingCalls.push({ toolCallId: m.toolCallId, toolName: m.toolName || '', toolInput: m.toolInput || {} });
      } else if (m.fullOutput != null && m.toolCallId) {
        toolResults.set(m.toolCallId, m.fullOutput);
        // 若该 tool-call 在 pending 中，立即 flush（保持时间线顺序）
        const idx = pendingCalls.findIndex(c => c.toolCallId === m.toolCallId);
        if (idx >= 0) {
          flushAssistant();
          msgs.push({
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: m.toolCallId, toolName: m.toolName, output: { type: 'text', value: m.fullOutput } }],
          });
        }
      }
    } else if (m.role === 'system') {
      flushAssistant();
      msgs.push({ role: 'system', content: m.content });
    }
  }

  // 收尾：未完成的工具调用 → 补充 toolResult
  // （注意：先取副本，flushAssistant 会清空 pendingCalls）
  const unfinished = [...pendingCalls];
  flushAssistant();
  for (const c of unfinished) {
    const output = toolResults.get(c.toolCallId);
    const value = output ?? '【未完成】工具调用被中断，未收到结果';
    msgs.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: { type: 'text', value } }],
    });
  }

  const ts = Date.now();
  return {
    version: 1,
    timestamp: new Date(ts).toISOString(),
    sessionId: `subagent-${peer}-${ts.toString(36)}`,
    title: `子模型 ${peer} 消息快照`,
    kind: 'subagent-session',
    agentMessages: msgs,
  };
}

