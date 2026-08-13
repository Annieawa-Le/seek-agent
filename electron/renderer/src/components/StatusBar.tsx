import type { AgentStatusState } from '@/hooks/useAgentStatus.ts';

interface Props {
  status: AgentStatusState;
  toolCallTotal: number;
  totalMessages: number;
}

export function StatusBar({ status, toolCallTotal, totalMessages }: Props) {
  const text = status.connectionState === 'connecting'
    ? '连接中...'
    : status.activity === 'listening' ? '审查中...'
    : status.activity === 'thinking' ? '思考中...'
    : status.activity === 'processing' ? '处理中...'
    : status.connected ? '就绪' : '已断开';

  const kb = status.kbStatus;
  const kbLabel = kb.phase === 'building' ? `知识库 ${kb.message}` : '';

  return (
    <div id="main-status">
      <span className="ms-left">
        <span className="status-dot-mini" data-state={status.connectionState} />
        <span className="status-text">{text}</span>
        {toolCallTotal > 0 && <span className="tools-badge">工具 {toolCallTotal}</span>}
        {kb.phase === 'building' && <span className="kb-status building">{kbLabel}</span>}
        {kb.phase === 'done' && <span className="kb-status done">知识库<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 3, verticalAlign: '-1px' }}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></span>}
        {kb.phase === 'failed' && <span className="kb-status failed">知识库<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 3, verticalAlign: '-1px' }}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>}
      </span>
      <span className="ms-right">
        <span className="ms-stat">消息 {totalMessages}</span>
        {status.ctxTokens > 0 && <span className="ms-stat">Token {status.ctxTokens}</span>}
      </span>
    </div>
  );
}


