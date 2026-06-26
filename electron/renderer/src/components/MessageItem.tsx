import type { DisplayMessage } from '@/hooks/useMessages.ts';
import { renderMarkdown, renderAnsi, escapeHtml } from '@/utils/markdown.ts';

interface Props {
  msg: DisplayMessage;
  onNavigateTool?: (msgId: number, dir: 'prev' | 'next') => void;
}

export function MessageItem({ msg, onNavigateTool }: Props) {
  switch (msg.role) {
    case 'user':
      return (
        <div className="message user">
          <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
        </div>
      );

    case 'agent':
      return (
        <div className={`message agent${msg.streaming ? ' streaming' : ''}${!msg.streaming ? ' round-ended' : ''}`}>
          <div className="message-agent-header"><span>小鲸鱼Deepseek</span></div>
          <div className="content">
            {msg.content && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />}
            {msg.toolHistory && msg.toolHistory.length > 0 && (
              <ToolHistoryDisplay msg={msg} onNavigate={onNavigateTool} />
            )}
          </div>
        </div>
      );

    case 'tool':
      if (msg.toolMeta) {
        const argsStr = Object.entries(msg.toolMeta.args || {})
          .map(([k, v]) => {
            const vStr = typeof v === 'string' ? v : JSON.stringify(v);
            return vStr.length > 40 ? `${k}=${vStr.slice(0, 40)}...` : `${k}=${vStr}`;
          }).join(', ');
        return (
          <div className="message tool collapsed">
            <div className="content">
              <span className="tool-collapse-icon"></span>
              <span className="tool-name">{escapeHtml(msg.toolMeta.toolName)}</span>
              <span className="tool-args">{escapeHtml(argsStr)}</span>
            </div>
          </div>
        );
      }
      return (
        <div className="message tool result">
          <div className="content" dangerouslySetInnerHTML={{ __html: renderAnsi(msg.content) }} />
        </div>
      );

    case 'system':
      return <div className="message system"><div className="content">{escapeHtml(msg.content)}</div></div>;

    case 'subagent':
      return (
        <div className="message subagent">
          <div className="message-subagent-header">💬 {escapeHtml(msg.subagentName || '子模型')}</div>
          <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
        </div>
      );

    case 'divider': return <div className="message divider" />;
    case 'blank': return <div className="message blank" />;
    case 'banner':
      return <div className="message banner"><div className="content" style={{ userSelect: 'none' }}>{escapeHtml(msg.content)}</div></div>;

    default: return null;
  }
}

function ToolHistoryDisplay({ msg, onNavigate }: {
  msg: DisplayMessage;
  onNavigate?: (msgId: number, dir: 'prev' | 'next') => void;
}) {
  const history = msg.toolHistory!;
  const idx = msg.toolHistoryIndex ?? history.length - 1;
  const entry = history[idx];
  if (!entry) return null;
  const lines = entry.fullOutput ? entry.fullOutput.split('\n').length : 0;

  return (
    <>
      {entry.paramsHtml && <div className="agent-tool-params" dangerouslySetInnerHTML={{ __html: entry.paramsHtml }} />}
      <div className="agent-tool-container">
        <div className="agent-tool-call">{entry.toolName}</div>
        <div className="agent-tool-result">
          <ToolResultContent entry={entry} lines={lines} />
        </div>
      </div>
      {history.length > 1 && (
        <div className="agent-tool-counter">
          <span className={`tool-counter-arrow${idx <= 0 ? ' disabled' : ''}`} onClick={() => onNavigate?.(msg.id, 'prev')}>◀</span>
          <span className="tool-counter-text">{idx + 1}/{history.length}</span>
          <span className={`tool-counter-arrow${idx >= history.length - 1 ? ' disabled' : ''}`} onClick={() => onNavigate?.(msg.id, 'next')}>▶</span>
        </div>
      )}
    </>
  );
}

function ToolResultContent({ entry, lines }: { entry: { resultHtml?: string | null; fullOutput?: string | null }; lines: number }) {
  const content = entry.resultHtml
    ? <div dangerouslySetInnerHTML={{ __html: entry.resultHtml }} />
    : <pre className="tool-result-pre">{entry.fullOutput || ''}</pre>;

  if (lines > 8) {
    return (
      <div className="tool-result-scroll-wrap collapsed">
        <div className="tool-result-scroll-container">{content}</div>
        <button className="tool-result-toggle" onClick={(e) => {
          const wrap = (e.target as HTMLElement).closest('.tool-result-scroll-wrap')!;
          const isCollapsed = wrap.classList.contains('collapsed');
          wrap.classList.toggle('collapsed');
          wrap.classList.toggle('expanded');
          (e.target as HTMLElement).textContent = isCollapsed ? '▲' : '▼';
        }}>▼</button>
      </div>
    );
  }

  return (
    <div className="tool-result-scroll-wrap">
      <div className="tool-result-scroll-container">{content}</div>
    </div>
  );
}
