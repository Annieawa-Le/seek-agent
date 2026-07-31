import { useState, useRef, useCallback } from 'react';
import type { AgentMessage, ToolHistoryEntry, PanelState } from '@/types/index.ts';

export interface DisplayMessage {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'system' | 'subagent' | 'divider' | 'blank' | 'banner' | 'thinking';
  content: string;
  createdAt: number;
  toolMeta?: { toolName: string; args?: Record<string, unknown> };
  toolCallHtml?: string;
  toolResultHtml?: string;
  fullOutput?: string;
  subagentName?: string;
  streaming?: boolean;
  toolHistory?: ToolHistoryEntry[];
  toolHistoryIndex?: number;
  /** 所属轮次：用于判断工具调用是否能并入该气泡 */
  roundId?: number;
}

export function useMessages() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingAgentId, setStreamingAgentId] = useState<number | null>(null);
  const msgIdRef = useRef(0);
  const roundRef = useRef(0);
  const panelRef = useRef<PanelState>({
    totalMessages: 0, userMessages: 0, agentMessages: 0, toolCallCount: 0,
  });

  const nextId = useCallback(() => ++msgIdRef.current, []);

  /** 开启新一轮（用户发送新消息时调用）：之后的 agent 气泡归属新轮次 */
  const beginNewRound = useCallback(() => {
    roundRef.current += 1;
  }, []);

  const appendMessage = useCallback((msg: Partial<DisplayMessage> & { role: DisplayMessage['role'] }) => {
    const id = nextId();
    const entry: DisplayMessage = { id, content: msg.content ?? '', createdAt: msg.createdAt ?? Date.now(), ...msg };

    setMessages(prev => {
      // 空气泡（来自 addAgentMessage('')）不创建可见气泡，仅 commit 上一轮
      if (entry.role === 'agent' && !entry.content && !msg.toolMeta) {
        const cleaned = prev.map(m => ({
          ...m,
          streaming: m.role === 'agent' ? false : m.streaming
        }));
        return cleaned;
      }

      panelRef.current.totalMessages++;
      if (entry.role === 'user') panelRef.current.userMessages++;
      else if (entry.role === 'agent') panelRef.current.agentMessages++;

      if (entry.role === 'agent') {
        const cleaned = prev.map(m => ({ ...m, streaming: m.role === 'agent' ? false : m.streaming }));
        return [...cleaned, { ...entry, streaming: true, roundId: roundRef.current }];
      }
      return [...prev, { ...entry, roundId: roundRef.current }];
    });

    if (entry.role === 'agent') setStreamingAgentId(id);
    return id;
  }, [nextId]);

  const appendToStreaming = useCallback((text: string) => {
    setMessages(prev => {
      // 只找 agent 文本气泡，绝不追加到 thinking 气泡
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'agent' && m.streaming) {
          const updated = [...prev];
          updated[i] = { ...m, content: m.content + text };
          return updated;
        }
      }
      const id = nextId();
      panelRef.current.totalMessages++;
      panelRef.current.agentMessages++;
      return [...prev, { id, role: 'agent' as const, content: text, createdAt: Date.now(), streaming: true, roundId: roundRef.current }];
    });
  }, [nextId]);

  /** 思考模式：开始一个思考气泡（总是新建，与历史思考气泡彻底隔离） */
  const startThinking = useCallback(() => {
    const id = nextId();
    setMessages(prev => {
      panelRef.current.totalMessages++;
      return [...prev, { id, role: 'thinking' as const, content: '', createdAt: Date.now(), streaming: true, roundId: roundRef.current }];
    });
  }, [nextId]);

  /** 思考模式：追加一段思考文本到当前思考气泡 */
  const appendThinkingDelta = useCallback((text: string) => {
    setMessages(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'thinking' && m.streaming) {
          const updated = [...prev];
          updated[i] = { ...m, content: m.content + text };
          return updated;
        }
      }
      // 没有活跃思考气泡则新建
      const id = nextId();
      panelRef.current.totalMessages++;
      return [...prev, { id, role: 'thinking' as const, content: text, createdAt: Date.now(), streaming: true, roundId: roundRef.current }];
    });
  }, [nextId]);

  /** 思考模式：结束所有仍处于 streaming 的思考气泡（防止旧气泡残留吞并正文） */
  const endThinking = useCallback(() => {
    setMessages(prev => {
      const updated = prev.map(m => (m.role === 'thinking' ? { ...m, streaming: false } : m));
      return updated;
    });
  }, []);

  const addToolToAgent = useCallback((toolMsg: AgentMessage) => {
    setMessages(prev => {
      // 找最后一个属于当前轮次的 agent 气泡（不限 streaming），并入工具历史
      let agentIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'agent' && m.roundId === roundRef.current) { agentIdx = i; break; }
      }

      // 没有 agent 气泡时：若当前轮次存在 thinking 气泡（思考中调用工具），并入其中
      if (agentIdx === -1) {
        for (let i = prev.length - 1; i >= 0; i--) {
          const m = prev[i];
          if (m.role === 'thinking' && m.roundId === roundRef.current) { agentIdx = i; break; }
        }
      }

      // 当前轮次还没有可承载的气泡，新建 agent 气泡
      if (agentIdx === -1) {
        const id = nextId();
        panelRef.current.totalMessages++;
        panelRef.current.agentMessages++;
        const newMsg: DisplayMessage = {
          id, role: 'agent', content: '', createdAt: Date.now(), streaming: true,
          roundId: roundRef.current,
          toolHistory: [{ paramsHtml: toolMsg.content || '', toolName: toolMsg.toolMeta?.toolName || '', resultHtml: null, fullOutput: null }],
          toolHistoryIndex: 0,
        };
        setStreamingAgentId(id);
        return [...prev, newMsg];
      }

      const updated = [...prev];
      const agent = { ...updated[agentIdx] };
      // 生成新数组而非原地 push，保证 memo 比较器能看到引用变化
      const history = agent.toolHistory ? [...agent.toolHistory] : [];
      history.push({
        paramsHtml: toolMsg.toolCallHtml || toolMsg.content || '',
        toolName: toolMsg.toolMeta?.toolName || '',
        resultHtml: null, fullOutput: null,
      });
      agent.toolHistory = history;
      agent.toolHistoryIndex = history.length - 1;
      updated[agentIdx] = agent;
      return updated;
    });
  }, [nextId]);

  const updateToolResult = useCallback((resultMsg: AgentMessage) => {
    setMessages(prev => {
      // 结果消息紧跟调用消息：找最后一个属于当前轮次且有工具历史的 agent 气泡
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if ((m.role === 'agent' || m.role === 'thinking') && m.roundId === roundRef.current && m.toolHistory && m.toolHistory.length > 0) {
          const updated = [...prev];
          const agent = { ...updated[i] };
          const history = [...(agent.toolHistory || [])];
          const lastEntry = { ...history[history.length - 1] };
          lastEntry.resultHtml = resultMsg.toolResultHtml || null;
          lastEntry.fullOutput = resultMsg.fullOutput || null;
          history[history.length - 1] = lastEntry;
          agent.toolHistory = history;
          updated[i] = agent;
          return updated;
        }
      }
      return prev;
    });
  }, []);

  const setToolCallCount = useCallback((count: number) => {
    panelRef.current.toolCallCount = count;
  }, []);

  const navigateToolHistory = useCallback((msgId: number, direction: 'prev' | 'next') => {
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === msgId);
      if (idx === -1) return prev;
      const msg = prev[idx];
      if (!msg.toolHistory?.length) return prev;
      const currentIdx = msg.toolHistoryIndex ?? 0;
      let newIdx = currentIdx;
      if (direction === 'prev' && currentIdx > 0) newIdx = currentIdx - 1;
      if (direction === 'next' && currentIdx < msg.toolHistory.length - 1) newIdx = currentIdx + 1;
      if (newIdx === currentIdx) return prev;
      const updated = [...prev];
      updated[idx] = { ...msg, toolHistoryIndex: newIdx };
      return updated;
    });
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setStreamingAgentId(null);
    panelRef.current = { totalMessages: 0, userMessages: 0, agentMessages: 0, toolCallCount: 0 };
  }, []);

  const removeLastAgent = useCallback((onlyIfStreaming?: boolean) => {
    setMessages(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'agent') {
          if (onlyIfStreaming && !prev[i].streaming) return prev;
          const updated = [...prev];
          updated.splice(i, 1);
          return updated;
        }
      }
      return prev;
    });
    setStreamingAgentId(null);
  }, []);

  const endStreaming = useCallback(() => {
    setMessages(prev => prev.map(m => ({ ...m, streaming: m.role === 'agent' ? false : m.streaming })));
    setStreamingAgentId(null);
  }, []);

  return {
    messages, streamingAgentId, panelState: panelRef,
    appendMessage, appendToStreaming, addToolToAgent, updateToolResult,
    setToolCallCount, navigateToolHistory, clearMessages, removeLastAgent, endStreaming,
    startThinking, appendThinkingDelta, endThinking, beginNewRound,
  };
}

