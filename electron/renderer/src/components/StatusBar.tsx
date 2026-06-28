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
        {kb.phase === 'done' && <span className="kb-status done">知识库✓</span>}
        {kb.phase === 'failed' && <span className="kb-status failed">知识库✗</span>}
      </span>
      <span className="ms-right">
        <span className="ms-stat">消息 {totalMessages}</span>
        {status.ctxTokens > 0 && <span className="ms-stat">Token {status.ctxTokens}</span>}
      </span>
    </div>
  );
}

