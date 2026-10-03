import { memo, useState, useEffect, useRef, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DisplayMessage } from '@/hooks/useMessages.ts';
import { renderMarkdownWithMath, renderAnsi, escapeHtml } from '@/utils/markdown.ts';
import { replaceEmojiWithSvg } from '@/utils/emoji-icons.ts';
import type { ToolHistoryEntry } from '@/types/index.ts';
import { formatToolDisplayName } from '@/utils/tool-display-config.ts';
import { renderViaContentRenderer } from '@/utils/content-extension.ts';

interface Props {
  msg: DisplayMessage;
}

/**
 * 自定义比较器：仅在影响渲染的字段变化时才重渲染。
 * useMessages 的流式更新会对所有消息做浅拷贝（endStreaming 等），
 * 引用比较会失效，因此需要逐字段比较，避免整列表随单条消息刷新。
 */
function messagePropsEqual(prev: Props, next: Props): boolean {
  const a = prev.msg;
  const b = next.msg;
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.streaming === b.streaming &&
    a.content === b.content &&
    a.subagentName === b.subagentName &&
    a.toolMeta === b.toolMeta &&
    a.toolHistory === b.toolHistory &&
    a.toolHistoryIndex === b.toolHistoryIndex
  );
}

export const MessageItem = memo(function MessageItem({ msg }: Props) {
  switch (msg.role) {
    case 'user':
      return <UserMessage content={msg.content} />;

    case 'agent':
      return (
        <div className={`message agent${msg.streaming ? ' streaming' : ''}${!msg.streaming ? ' round-ended' : ''}`}>
          <div className="content">
            {msg.content && <AgentContent content={msg.content} streaming={!!msg.streaming} msgId={msg.id} />}
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
              <span className="tool-name">{escapeHtml(formatToolDisplayName(msg.toolMeta.toolName, msg.toolMeta.args))}</span>
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

    case 'thinking':
      return (
        <div className={`message thinking${msg.streaming ? ' streaming' : ''}`}>
          <div className="thinking-header">
            <svg className="thinking-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/><path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z"/>
            </svg>
            <span className="thinking-title">思考过程</span>
            {msg.streaming && <span className="thinking-dots">⠋</span>}
          </div>
          {msg.content && <div className="thinking-body content" dangerouslySetInnerHTML={{ __html: renderMarkdownWithMath(msg.content) }} />}
          {msg.toolHistory && msg.toolHistory.length > 0 && (
            <ToolHistoryDisplay history={msg.toolHistory} />
          )}
        </div>
      );

    case 'subagent':
      return (
        <div className="message subagent">
          <div className="message-subagent-header"><svg className="subagent-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> {escapeHtml(msg.subagentName || '子模型')}</div>
          <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdownWithMath(msg.content) }} />
        </div>
      );

    case 'divider': return <div className="message divider" />;

    case 'instructor':
      // instructor 建议：复用用户气泡样式，头部用小鲸鱼标志区分
      return (
        <div className="message user instructor">
          <div className="message-instructor-header">
            <svg className="instructor-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 16.5c1-2.5 3.5-4 7-4 2.6 0 4.9 1 6.7 2.5"/>
              <path d="M16.2 15l4.8-3.3-.9 4.2"/>
              <path d="M2.5 16.5c1.2 1.6 3.3 2.4 5.4 2.4h5.6c1.5 0 2.6-.9 2.6-2.1"/>
              <path d="M9.5 12.5v-2"/>
              <path d="M9.5 10.5c-.7-.8 0-1.6 0-2.4 0 .8.7 1.6 0 2.4"/>
              <circle cx="15.7" cy="13.4" r="0.5" fill="currentColor" stroke="none"/>
            </svg>
            <span className="instructor-name">{escapeHtml(msg.subagentName || '教练')}</span>
            <span className="instructor-tag">建议</span>
          </div>
          <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdownWithMath(msg.content) }} />
        </div>
      );

    case 'blank': return <div className="message blank" />;
    case 'banner':
      return <div className="message banner"><div className="content" style={{ userSelect: 'none' }}>{escapeHtml(msg.content)}</div></div>;

    default: return null;
  }
}, messagePropsEqual);

/**
 * 助手正文：优先交给已注册的内容扩展渲染器（插件注入，渲染层对其零知识）；
 * 无扩展接管时退回默认 markdown 渲染——与扩展点引入前行为完全一致。
 *
 * memo：流式时内容逐字增长、气泡内其余部分不变，避免父级重渲染时连带刷新。
 */
const AgentContent = memo(function AgentContent({ content, streaming, msgId }: { content: string; streaming: boolean; msgId: number }) {
  const custom: ReactNode = renderViaContentRenderer(content, { streaming, key: `msg-${msgId}` });
  if (custom !== null) return <>{custom}</>;
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdownWithMath(content) }} />;
});

const ToolHistoryDisplay = memo(function ToolHistoryDisplay({ history: rawHistory }: {
  history: ToolHistoryEntry[];
}) {
  // 过滤掉还没有结果返回的条目（正在执行中的）；rawHistory 引用不变时复用过滤结果
  const history = useMemo(
    () => rawHistory.filter(e => e.fullOutput !== null || e.resultHtml !== null),
    [rawHistory]
  );

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

  if (history.length === 0) return null;

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
                  <span className="timeline-tool-name">{escapeHtml(formatToolDisplayName(entry.toolName, entry.args))}</span>
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
});

const ToolResultContent = memo(function ToolResultContent({ entry, lines }: { entry: { resultHtml?: string | null; fullOutput?: string | null }; lines: number }) {
  // 有 resultHtml（来自 rawBulk 的 toWebUI）→ 结构化 HTML 渲染
  // 无 resultHtml → 用 renderAnsi 增强纯文本（转义 + ANSI 颜色）
  // 两条路最后都过一遍 emoji → 内联 SVG，统一图标尺寸与色彩
  const content = entry.resultHtml
    ? <div dangerouslySetInnerHTML={{ __html: replaceEmojiWithSvg(entry.resultHtml) }} />
    : <div className="tool-result-ansi" dangerouslySetInnerHTML={{ __html: replaceEmojiWithSvg(renderAnsi(entry.fullOutput || '')) }} />;

  if (lines > 8) {
    return (
      <div className="tool-result-scroll-wrap collapsed">
        <div className="tool-result-scroll-container">{content}</div>
        <button className="tool-result-toggle" onClick={(e) => {
          const wrap = (e.target as HTMLElement).closest('.tool-result-scroll-wrap')!;
          wrap.classList.toggle('collapsed');
          wrap.classList.toggle('expanded');
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="tool-result-scroll-wrap">
      <div className="tool-result-scroll-container">{content}</div>
    </div>
  );
});

/** 预处理附件链接并渲染为卡片 */
const UserMessage = memo(function UserMessage({ content }: { content: string }) {
  // 检测 markdown 格式的附件链接 [文件名](路径)
  // 这些是由 InputBar 的 handleSend 生成的
  const fileLinkRegex = /\[([^\]]+)\]\(([^)]+\.\w+)\)/g;

  const parts: Array<{ type: 'text' | 'file'; value: string }> = [];
  let lastIndex = 0;
  let match;

  while ((match = fileLinkRegex.exec(content)) !== null) {
    // 匹配前的纯文本
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'file', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  // 剩余文本
  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  // 如果没有附件链接，直接走普通 markdown 渲染
  if (!parts.some(p => p.type === 'file')) {
    return (
      <div className="message user">
        <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdownWithMath(content) }} />
      </div>
    );
  }

  return (
    <div className="message user">
      <div className="content">
        {parts.map((part, i) => {
          if (part.type === 'file') {
            // 解析文件名和路径
            const fileMatch = part.value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
            if (!fileMatch) return null;
            const [, fileName, filePath] = fileMatch;
            const ext = fileName.split('.').pop()?.toLowerCase() || '';

            // 根据扩展名选择图标
            const isImage = ['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif','tiff'].includes(ext);
            const isDoc = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','json','xml','csv'].includes(ext);
            const isCode = ['ts','tsx','js','jsx','py','java','c','cpp','h','hpp','rs','go','rb','php','vue','css','scss','less','html'].includes(ext);

            let iconSvg = '';
            if (isImage) {
              iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
            } else if (isDoc) {
              iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
            } else if (isCode) {
              iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
            } else {
              iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
            }

            return (
              <div key={i} className="file-attachment-card" title={filePath}>
                <div className="file-attachment-icon" dangerouslySetInnerHTML={{ __html: iconSvg }} />
                <div className="file-attachment-info">
                  <span className="file-attachment-name">{escapeHtml(fileName)}</span>
                  <span className="file-attachment-path">{escapeHtml(filePath)}</span>
                </div>
              </div>
            );
          }
          // 纯文本段落走普通 markdown
          if (!part.value.trim()) return null;
          return (
            <div key={i} className="content-text" dangerouslySetInnerHTML={{ __html: renderMarkdownWithMath(part.value) }} />
          );
        })}
      </div>
    </div>
  );
});














