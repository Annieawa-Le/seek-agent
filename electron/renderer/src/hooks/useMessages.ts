import { useState, useRef, useCallback } from 'react';
import type { AgentMessage, ToolHistoryEntry, PanelState } from '@/types/index.ts';

export interface DisplayMessage {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'system' | 'subagent' | 'divider' | 'blank' | 'banner';
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
}

export function useMessages() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingAgentId, setStreamingAgentId] = useState<number | null>(null);
  const msgIdRef = useRef(0);
  const panelRef = useRef<PanelState>({
    totalMessages: 0, userMessages: 0, agentMessages: 0, toolCallCount: 0,
  });

  const nextId = useCallback(() => ++msgIdRef.current, []);

  const appendMessage = useCallback((msg: Partial<DisplayMessage> & { role: DisplayMessage['role'] }) => {
    const id = nextId();
    const entry: DisplayMessage = { id, content: msg.content ?? '', createdAt: msg.createdAt ?? Date.now(), ...msg };

    setMessages(prev => {
      if (entry.role === 'agent' && !entry.content && !msg.toolMeta) return prev;
      panelRef.current.totalMessages++;
      if (entry.role === 'user') panelRef.current.userMessages++;
      else if (entry.role === 'agent') panelRef.current.agentMessages++;

      if (entry.role === 'agent') {
        const cleaned = prev.map(m => ({ ...m, streaming: m.role === 'agent' ? false : m.streaming }));
        return [...cleaned, { ...entry, streaming: true }];
      }
      return [...prev, entry];
    });

    if (entry.role === 'agent') setStreamingAgentId(id);
    return id;
  }, [nextId]);

  const appendToStreaming = useCallback((text: string) => {
    setMessages(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'agent' && m.streaming && !m.toolHistory?.length) {
          const updated = [...prev];
          updated[i] = { ...m, content: m.content + text };
          return updated;
        }
      }
      const id = nextId();
      panelRef.current.totalMessages++;
      panelRef.current.agentMessages++;
      return [...prev, { id, role: 'agent' as const, content: text, createdAt: Date.now(), streaming: true }];
    });
  }, [nextId]);

  const addToolToAgent = useCallback((toolMsg: AgentMessage) => {
    setMessages(prev => {
      let agentIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'agent') { agentIdx = i; break; }
      }

      if (agentIdx === -1) {
        const id = nextId();
        panelRef.current.totalMessages++;
        panelRef.current.agentMessages++;
        const newMsg: DisplayMessage = {
          id, role: 'agent', content: '', createdAt: Date.now(), streaming: true,
          toolHistory: [{ paramsHtml: toolMsg.content || '', toolName: toolMsg.toolMeta?.toolName || '', resultHtml: null, fullOutput: null }],
          toolHistoryIndex: 0,
        };
        setStreamingAgentId(id);
        return [...prev, newMsg];
      }

      const updated = [...prev];
      const agent = { ...updated[agentIdx] };
      if (!agent.toolHistory) { agent.toolHistory = []; agent.toolHistoryIndex = -1; }
      agent.toolHistory.push({
        paramsHtml: toolMsg.toolCallHtml || toolMsg.content || '',
        toolName: toolMsg.toolMeta?.toolName || '',
        resultHtml: null, fullOutput: null,
      });
      agent.toolHistoryIndex = agent.toolHistory.length - 1;
      updated[agentIdx] = agent;
      return updated;
    });
  }, [nextId]);

  const updateToolResult = useCallback((resultMsg: AgentMessage) => {
    setMessages(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'agent' && m.toolHistory && m.toolHistory.length > 0) {
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

  const removeLastAgent = useCallback(() => {
    setMessages(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'agent') {
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
  };
}

