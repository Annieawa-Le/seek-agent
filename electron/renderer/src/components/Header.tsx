import { useState, useEffect } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { AgentStatusState } from '@/hooks/useAgentStatus.ts';

interface Props {
  status: AgentStatusState;
  ctxTokens: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

const dotClass: Record<string, string> = {
  connected: 'status-dot connected',
  disconnected: 'status-dot disconnected',
  connecting: 'status-dot disconnected',
};

export function Header({ status, ctxTokens, theme, onToggleTheme }: Props) {
  const api = useElectronAPI();
  const { minimizeWindow, maximizeWindow, closeWindow, onMaximizedChange, isWindowMaximized } = api;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    isWindowMaximized().then(setIsMaximized);
    const unsub = onMaximizedChange(setIsMaximized);
    return () => unsub();
  }, [isWindowMaximized, onMaximizedChange]);

  const dotCls = dotClass[status.connectionState] || 'status-dot disconnected';
  const ctxText = ctxTokens > 0 ? `ctx: ${ctxTokens}t` : 'ctx: --';

  return (
    <header id="header">
      <div className="header-left">
        <svg className="header-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        <span className="header-title">Seek Agent</span>
      </div>

      <div className="header-center">
        <span className="header-session-name">New Session · seek-agent</span>
      </div>

      <div className="header-right">
        <span className="header-ctx" title="上下文长度">{ctxText}</span>

        <button className="theme-toggle" onClick={onToggleTheme}
          title={theme === 'dark' ? '切换亮色模式' : '切换暗色模式'}>
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>

        <span className={dotCls} title={status.connectionState} />

        <div className="window-controls">
          <button className="win-btn win-btn-minimize" onClick={minimizeWindow} title="最小化">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>
          </button>
          <button className="win-btn win-btn-maximize" onClick={maximizeWindow} title={isMaximized ? '还原' : '最大化'}>
            {isMaximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="3" y="0.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
                <rect x="0.5" y="3" width="8" height="8" rx="1" fill="var(--bg-base)" stroke="currentColor" strokeWidth="1"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
              </svg>
            )}
          </button>
          <button className="win-btn win-btn-close" onClick={closeWindow} title="关闭">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}

