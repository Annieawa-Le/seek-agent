import { useState, useEffect, useCallback } from 'react';
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
}

export function useAgentStatus() {
  const { onMessage, onStatus } = useElectronAPI();
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
  });

  const updateActivity = useCallback((s: AgentStatusState): AgentActivity => {
    if (s.listening) return 'listening';
    if (s.thinking) return 'thinking';
    if (s.processing) return 'processing';
    return 'idle';
  }, []);

  useEffect(() => {
    const unsubMsg = onMessage((msg) => {
      switch (msg.type) {
        case 'state':
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
      }
    });

    const unsubStatus = onStatus((s) => {
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

  return status;
}
