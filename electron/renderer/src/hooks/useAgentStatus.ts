import { useState, useEffect, useRef, useCallback } from 'react';
import { useElectronAPI } from './useElectronAPI.ts';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
export type AgentActivity = 'idle' | 'processing' | 'thinking' | 'listening';

export interface AgentStatusState {
  connected: boolean;
  connectionState: ConnectionState;
  processing: boolean;
  thinking: boolean;
  listening: boolean;
  activity: AgentActivity;
  ctxChars: number;
  ctxTokens: number;
  toolCallTotal: number;
  /** 知识库索引构建状态 */
  kbStatus: { phase: 'idle' | 'building' | 'done' | 'failed'; message: string };
}

/**
 * Agent 运行状态 hook。
 * @param currentSessionId 当前活动会话：只接收该会话的消息/状态，切换会话时自动刷新
 */
export function useAgentStatus(currentSessionId: string = 'default') {
  const { onMessage, onStatus, getAgentStatus } = useElectronAPI();
  const sessionRef = useRef(currentSessionId);
  useEffect(() => {
    sessionRef.current = currentSessionId;
    // 切换会话：新会话默认空闲（processing/thinking/listening 归零），立即恢复发送按钮；
    // 真实状态由 state / input-state 消息纠正（正在运行的会话激活时会推送真实快照）
    setStatus(prev => {
      const next = { ...prev, processing: false, thinking: false, listening: false };
      next.activity = updateActivity(next);
      return next;
    });
    // 切换会话后主动查询新会话的连接状态
    getAgentStatus().then(result => {
      setStatus(prev => {
        const connected = !!result?.connected;
        const connectionState: ConnectionState = connected ? 'connected' : 'connecting';
        const next = { ...prev, connected, connectionState };
        next.activity = updateActivity(next);
        return next;
      });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  const [status, setStatus] = useState<AgentStatusState>({
    connected: false,
    connectionState: 'connecting',
    processing: false,
    thinking: false,
    listening: false,
    activity: 'idle',
    ctxChars: 0,
    ctxTokens: 0,
    toolCallTotal: 0,
    kbStatus: { phase: 'idle', message: '' },
  });

  const updateActivity = useCallback((s: AgentStatusState): AgentActivity => {
    if (s.listening) return 'listening';
    if (s.thinking) return 'thinking';
    if (s.processing) return 'processing';
    return 'idle';
  }, []);

  useEffect(() => {
    const unsubMsg = onMessage((msg) => {
      // 只处理当前活动会话的消息
      if ((msg.sessionId || 'default') !== sessionRef.current) return;
      switch (msg.type) {
        case 'state':
          setStatus(prev => {
            const next = { ...prev, processing: msg.processing ?? prev.processing };
            next.activity = updateActivity(next);
            return next;
          });
          break;
        case 'input-state':
          // 会话激活/就绪时推送的真实快照：覆盖 processing（空闲会话的发送按钮立即恢复）
          setStatus(prev => {
            const next = { ...prev, processing: msg.processing ?? prev.processing };
            next.activity = updateActivity(next);
            return next;
          });
          break;
        case 'thinking':
          setStatus(prev => {
            const next = { ...prev, thinking: msg.active ?? false };
            next.activity = updateActivity(next);
            return next;
          });
          break;
        case 'listen':
          setStatus(prev => {
            const next = { ...prev, listening: msg.name !== null };
            next.activity = updateActivity(next);
            return next;
          });
          break;
        case 'context':
          setStatus(prev => ({
            ...prev,
            ctxChars: msg.chars ?? prev.ctxChars,
            ctxTokens: msg.tokens ?? prev.ctxTokens,
          }));
          break;
        case 'tool-call':
          setStatus(prev => ({ ...prev, toolCallTotal: msg.count ?? prev.toolCallTotal }));
          break;
        case 'kb-build':
          setStatus(prev => ({
            ...prev,
            kbStatus: { phase: msg.phase || 'idle', message: msg.message || '' },
          }));
          break;
      }
    });

    const unsubStatus = onStatus((s) => {
      // 只处理当前活动会话的连接状态
      if ((s.sessionId || 'default') !== sessionRef.current) return;
      setStatus(prev => {
        const connected = s.connected;
        const connectionState: ConnectionState = connected ? 'connected' : 'disconnected';
        const next = { ...prev, connected, connectionState };
        next.activity = updateActivity(next);
        return next;
      });
    });

    return () => { unsubMsg(); unsubStatus(); };
  }, [onMessage, onStatus, updateActivity]);

  // 挂载后主动查询当前连接状态（刷新后重新连接）
  useEffect(() => {
    getAgentStatus().then(result => {
      if (result?.connected) {
        setStatus(prev => ({ ...prev, connected: true, connectionState: 'connected' }));
      }
    });
  }, [getAgentStatus]);

  return status;
}



