import type { AgentStatusState } from '@/hooks/useAgentStatus.ts';

interface Props {
  status: AgentStatusState;
  toolCallTotal: number;
  totalMessages: number;
}

export function StatusBar({ status, toolCallTotal }: Props) {
  const text = status.connectionState === 'connecting'
    ? '正在连接 Agent...'
    : status.activity === 'listening' ? '审查中...'
    : status.activity === 'thinking' ? 'AI 思考中...'
    : status.activity === 'processing' ? '处理中...'
    : status.connected ? '就绪' : 'Agent 已退出';

  return (
    <div id="main-status">
      <span className="ms-left">
        <span className="status-text">{text}</span>
        {toolCallTotal > 0 && <span className="tools-badge">工具 {toolCallTotal}</span>}
      </span>
      <span className="ms-right">📁 Folder &nbsp;│&nbsp; Git Branch</span>
    </div>
  );
}
