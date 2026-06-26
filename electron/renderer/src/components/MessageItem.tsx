import { useState, useEffect, useRef } from 'react';
import type { DisplayMessage } from '@/hooks/useMessages.ts';
import { renderMarkdown, renderAnsi, escapeHtml } from '@/utils/markdown.ts';
import type { ToolHistoryEntry } from '@/types/index.ts';

interface Props {
  msg: DisplayMessage;
}


export function MessageItem({ msg }: Props) {
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
          <div className="content">
            {msg.content && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />}
            {msg.toolHistory && msg.toolHistory.length > 0 && (
              <ToolHistoryDisplay history={msg.toolHistory} />
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
          <div className="message-subagent-header"><svg className="subagent-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> {escapeHtml(msg.subagentName || '子模型')}</div>
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
function ToolHistoryDisplay({ history: rawHistory }: {
  history: ToolHistoryEntry[];
}) {
  // 过滤掉还没有结果返回的条目（正在执行中的）
  const history = rawHistory.filter(e => e.fullOutput !== null || e.resultHtml !== null);
  if (history.length === 0) return null;

  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const lastIdxRef = useRef(history.length - 1);

  // 默认展开最后一个，新调用进来时自动折叠到新的最后一个
  useEffect(() => {
    if (history.length > lastIdxRef.current) {
      // 有新增调用 → 展开新的最后一个
      setExpandedIdx(history.length - 1);
    } else if (expandedIdx === null && history.length > 0) {
      // 首次渲染
      setExpandedIdx(history.length - 1);
    }
    lastIdxRef.current = history.length;
  }, [history.length]);

  return (
    <div className="tool-timeline">
      <div className="tool-timeline-steps">
        {history.map((entry, i) => {
          const isLast = i === history.length - 1;
          const isExpanded = expandedIdx === i;
          const hasResult = entry.fullOutput !== null || entry.resultHtml !== null;
          return (
            <div key={i} className={`timeline-step${isLast ? ' is-last' : ''}${isExpanded ? ' is-expanded' : ''}${!hasResult ? ' no-result' : ''}`}>
              <div className="timeline-dot" />
              <div className="timeline-content">
                <div
                  className={`timeline-step-header${hasResult ? ' clickable' : ''}`}
                  onClick={() => hasResult && setExpandedIdx(isExpanded ? null : i)}
                >
                  <span className="timeline-tool-name">{escapeHtml(entry.toolName)}</span>
                  {hasResult && (
                    <span className={`timeline-expand-icon${isExpanded ? ' expanded' : ''}`}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </span>
                  )}
                </div>
                {isExpanded && hasResult && (
                  <div className="timeline-step-result">
                    <ToolResultContent entry={entry} lines={entry.fullOutput ? entry.fullOutput.split('\n').length : 0} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
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









