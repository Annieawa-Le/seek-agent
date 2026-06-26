import type { AgentStatusState } from '@/hooks/useAgentStatus.ts';

interface Props {
  status: AgentStatusState;
  ctxTokens: number;
}

const dotClass: Record<string, string> = {
  connected: 'status-dot connected',
  disconnected: 'status-dot disconnected',
  connecting: 'status-dot disconnected',
};

export function Header({ status, ctxTokens }: Props) {
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
        <span id="ctx-display" className="header-ctx" title="上下文长度">{ctxText}</span>
        <span id="status-dot" className={dotCls} title={status.connectionState} />
      </div>
    </header>
  );
}
