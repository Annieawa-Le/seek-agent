import { useState, useEffect, useCallback } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { SessionInfo, SidebarRuntimeData } from '@/types/index.ts';
import { useRemoteConnection } from './RemoteConnectionContext.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 当前活动会话 ID */
  currentSessionId: string;
  /** 当前会话的运行时数据（hooks/子agent/MCP 状态） */
  runtimeData: SidebarRuntimeData | null;
  onNewSession: () => void;
  /** 切换到指定会话（已保存会话传 name） */
  onSwitchSession: (sessionId: string, name?: string) => void;
  /** 会话列表更新回调（父组件用它同步标签页标题：sessionId/文件名 → 显示名） */
  onSessionsChanged?: (sessions: SessionInfo[]) => void;
}

export function LeftSidebar({ open, currentSessionId, runtimeData, onNewSession, onSwitchSession, onSessionsChanged }: Props) {
  const api = useElectronAPI();
  const conn = useRemoteConnection();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  /** 正在运行（processing）的会话集合 */
  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());
  /** 主进程存活的会话进程 */
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.listSessions();
      if (Array.isArray(data)) {
        setSessions(data);
        onSessionsChanged?.(data);
      }
    } catch {
      // 主进程 handler 可能暂不可用，保留旧列表，等待下一次定时刷新自愈
    }
  }, [api, onSessionsChanged]);

  const loadActive = useCallback(async () => {
    const data = await api.listActiveSessions();
    if (Array.isArray(data)) setActiveSessionIds(data.map(d => d.sessionId));
  }, [api]);

  useEffect(() => {
    loadSessions();
    loadActive();
    // 定时刷新：运行中会话每 5s，历史会话每 10s（主进程有签名缓存，开销小；失败可自愈、新会话自动出现）
    const t = setInterval(() => { loadActive(); loadSessions(); }, 10000);
    const tActive = setInterval(loadActive, 5000);
    return () => { clearInterval(t); clearInterval(tActive); };
  }, [loadSessions, loadActive]);

  // 工作区切换后立即刷新会话列表（不等 10s 轮询，且列表目录已随工作区切换）
  useEffect(() => {
    const unsub = api.onWorkdirChanged(() => { loadSessions(); loadActive(); });
    return () => unsub();
  }, [api, loadSessions, loadActive]);

  // 监听消息流：更新各会话的运行状态（后台会话也在继续跑）
  useEffect(() => {
    const unsub = api.onMessage((msg) => {
      if (!msg.sessionId) return;
      if (msg.type === 'state') {
        setRunningSessions(prev => {
          const next = new Set(prev);
          if (msg.processing) next.add(msg.sessionId as string);
          else next.delete(msg.sessionId as string);
          return next;
        });
      } else if (msg.type === 'tool-call' || msg.type === 'thinking' || msg.type === 'thinking-bubble') {
        if (msg.type === 'thinking' && !msg.active) {
          setRunningSessions(prev => {
            const next = new Set(prev);
            next.delete(msg.sessionId as string);
            return next;
          });
        } else {
          setRunningSessions(prev => new Set(prev).add(msg.sessionId as string));
        }
      }
    });
    return unsub;
  }, [api]);

  const handleNewSession = () => {
    onNewSession();
    // 稍后刷新（新进程拉起需要时间）
    setTimeout(() => { loadSessions(); loadActive(); }, 800);
  };

  const handleSwitchSession = (s: SessionInfo) => {
    // 优先用文件内 sessionId（new-xxx 形态，与自动保存/主进程/Agent 构造对齐），
    // 避免无存活进程时按文件名（标题）拉起，导致 worklog 归档分区对不上旧文件而计数归零；
    // 旧文件无 sessionId 字段时回退文件名（标题）。
    const target = s.sessionId || s.name;
    onSwitchSession(target, s.name);
  };

  return (
    <aside id="left-sidebar" className={open ? 'open' : ''}>
      <div className="sidebar-section-header">
        <span className="section-title">Sessions</span>
        <div className="section-actions">
          <button className="section-action-btn" title="面板/分屏"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
          <button className="section-action-btn" title="搜索"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
        </div>
      </div>

      <button id="new-session-btn" className="new-session-btn" onClick={handleNewSession}>
        <span className="ns-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
        <span className="ns-text">New</span>
        <span className="ns-shortcut">Ctrl+N</span>
      </button>

      <div id="session-list" className="session-list">
        {sessions.length === 0 && activeSessionIds.length === 0 ? <div className="session-empty">暂无会话</div> : <>
          {sessions.map(s => {
            const timeStr = s.timestamp ? new Date(s.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            // 显示名优先纯标题（title），回退文件名剥 session- 前缀（避免展示 session- 前缀/id 形态）
            const displayName = s.title || s.name.replace(/^session-/, '');
            // 活跃进程关联：进程 sessionId 匹配文件 sessionId（新身份）或文件名（旧文件/手动保存兜底）
            const alive = activeSessionIds.includes(s.sessionId as string) || activeSessionIds.includes(s.name);
            const isActive = currentSessionId === s.sessionId || currentSessionId === s.name;
            const isRunning = runningSessions.has(s.sessionId as string) || runningSessions.has(s.name) || (alive && isActive);
            return (
              <div key={s.name} className={`session-item${isActive ? ' active' : ''}`} onClick={() => handleSwitchSession(s)} title={`切换到会话 ${displayName}`}>
                <div className="session-name">
                  {displayName}
                  {isRunning && <span className="session-dot" title="该会话正在运行">●</span>}
                </div>
                <div className="session-meta-row">
                  <div className="session-meta">{s.messageCount} msgs{timeStr ? ` · ${timeStr}` : ''}</div>
                </div>
                {s.preview && <div className="session-preview">{s.preview.slice(0, 60)}</div>}
              </div>
            );
          })}
          {/* 运行中但尚未落盘的新会话（自动保存后 sessionId 出现在历史条目中，不再重复显示） */}
          {activeSessionIds.filter(id => !sessions.some(s => s.sessionId === id || s.name === id)).map(id => (
            <div key={id} className={`session-item${currentSessionId === id ? ' active' : ''}`} onClick={() => onSwitchSession(id)} title={`切换到运行中会话 ${id}`}>
              <div className="session-name">
                {id}
                <span className="session-dot running" title="该会话正在运行">●</span>
              </div>
              <div className="session-meta">运行中（未保存）</div>
            </div>
          ))}
        </>}
      </div>

      <div id="sidebar-spacer" />

      {conn && (
        <div id="remote-connect-btn-wrap" style={{ padding: '10px 12px', borderTop: '1px solid var(--border-color, #e5e7eb)' }}>
          <button
            id="remote-connect-btn"
            onClick={conn.openPanel}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: conn.paired ? 'rgba(56,158,13,0.12)' : 'var(--bg-hover, #f0f1f3)',
              color: conn.paired ? '#389e0d' : 'var(--text-secondary, #444)',
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
            {conn.paired ? '已连接' : '连接远程'}
            {conn.paired && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#389e0d', display: 'inline-block' }} />}
          </button>
        </div>
      )}

    </aside>
  );
}









































