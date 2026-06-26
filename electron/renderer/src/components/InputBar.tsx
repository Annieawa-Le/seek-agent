import { useState, useRef, useCallback, useEffect } from 'react';

interface Props {
  processing: boolean;
  thinking: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function InputBar({ processing, thinking, onSend, onAbort }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(36, el.scrollHeight) + 'px';
  }, []);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
  }, [value, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  useEffect(() => { setTimeout(() => textareaRef.current?.focus(), 300); }, []);

  return (
    <div className="input-bar">
      <div className="input-bar-body">
        {/* 统一框体 */}
        <div className="input-wrapper">
          {/* —— 上排：左侧胶囊 + 右侧操作按钮 —— */}
          <div className="input-toolbar">
            <div className="capsule-group">
              <button className="capsule-btn capsule-active" title="智能搜索">
                <svg className="capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
                <span>智能搜索</span>
              </button>
              <button className="capsule-btn" title="多agent协作">
                <svg className="capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
                <span>多agent协作</span>
              </button>
              <button className="capsule-btn" title="使用技能...">
                <svg className="capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                <span>使用技能...</span>
              </button>
            </div>
            <div className="input-toolbar-spacer" />
            <div className="input-actions">
              <button className="action-btn" title="添加附件">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
              </button>
              <button
                className={`send-btn${processing ? ' stop-mode' : ''}`}
                onClick={processing ? onAbort : handleSend}
                disabled={!processing && !value.trim()}
                title={processing ? '终止' : '发送'}
              >
                {processing ? (
                  <svg className="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg className="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          {/* —— 下排：文本输入区 —— */}
          <div className="input-field-area">
            <textarea
              id="message-input"
              ref={textareaRef}
              rows={1}
              placeholder="给 DeepSeek 发送消息"
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {thinking && <div className="thinking-indicator" title="AI 思考中…">⠋</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

