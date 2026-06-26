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
    <div id="input-bar" className="input-bar">
      <div id="thinking-spinner" className="thinking-spinner" style={{ display: thinking ? 'block' : 'none' }} title="AI 思考中…">⠋</div>
      <div className="input-wrapper">
        <textarea
          id="message-input"
          ref={textareaRef}
          rows={1}
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <button
        id="send-btn"
        className={`send-btn${processing ? ' stop-mode' : ''}`}
        onClick={processing ? onAbort : handleSend}
        disabled={!processing && !value.trim()}
        title={processing ? '终止' : '发送'}
      >
        {processing ? (
          <svg id="stop-icon" className="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg id="send-icon" className="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        )}
      </button>
    </div>
  );
}
