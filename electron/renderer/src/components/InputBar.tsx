import { useState, useRef, useCallback, useEffect } from 'react';
import { isElectron } from '@/hooks/useElectronAPI.ts';

interface Attachment {
  name: string;
  path: string;
}

interface Props {
  processing: boolean;
  thinking: boolean;
  kbEnabled: boolean;
  thinkingEnabled: boolean;
  onToggleThinking: (enabled: boolean) => void;
  smartSearchEnabled: boolean;
  skillsList: Array<{ name: string; description: string }>;
  onSend: (text: string) => void;
  onAbort: () => void;
  onToggleKb: () => void;
  onToggleSmartSearch: (enabled: boolean) => void;
}

function inferSkillLabel(name: string, description: string): string {
  const descMatch = description.match(/^[\u4e00-\u9fff\w\s]+/);
  const descLabel = descMatch ? descMatch[0].trim() : '';
  if (descLabel.length >= 4 && descLabel.length <= 20) return descLabel;

  const parts = name.split('-').filter(Boolean);
  const label = parts
    .map(p => {
      if (p === 'ui') return 'UI';
      if (p === 'ux') return 'UX';
      if (p === 'api') return 'API';
      if (p === 'pdf') return 'PDF';
      if (p === 'ppt') return 'PPT';
      if (p === 'html') return 'HTML';
      if (p === 'md') return 'MD';
      if (p === 'ocr') return 'OCR';
      if (p === 'cli') return 'CLI';
      if (p === 'ai') return 'AI';
      if (p === 'id') return 'ID';
      if (p === 'todo') return '待办';
      if (p === 'ref') return '参考';
      if (p === 'sub') return '子';
      if (p === 'kb') return '知识库';
      if (p === 'gh') return 'Git';
      if (p === 'mc') return 'MC';
      if (p === 'icon') return '图标';
      if (p === 'code') return '代码';
      if (p === 'web') return '网页';
      if (p === 'tavily') return 'Tavily';
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
  return label;
}

export function InputBar({
  processing, thinking, kbEnabled, smartSearchEnabled, thinkingEnabled, skillsList,
  onSend, onAbort, onToggleKb, onToggleSmartSearch, onToggleThinking,
}: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [skillsOpen, setSkillsOpen] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(36, el.scrollHeight) + 'px';
  }, []);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSkillsOpen(false);
      }
    }
    if (skillsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [skillsOpen]);

  const handleToggleSmartSearch = useCallback(() => {
    onToggleSmartSearch(!smartSearchEnabled);
  }, [smartSearchEnabled, onToggleSmartSearch]);

  const handleToggleThinking = useCallback(() => {
    onToggleThinking(!thinkingEnabled);
  }, [thinkingEnabled, onToggleThinking]);

  const toggleSkillsDropdown = useCallback(() => {
    setSkillsOpen(prev => !prev);
  }, []);

  const toggleSkill = useCallback((skillName: string) => {
    setSelectedSkills(prev => {
      const next = new Set(prev);
      if (next.has(skillName)) {
        next.delete(skillName);
      } else {
        next.add(skillName);
      }
      return next;
    });
  }, []);

  const hasSelectedSkills = selectedSkills.size > 0;

  // 打开文件选择对话框
  const handleAttach = useCallback(async () => {
    if (!isElectron()) return;
    const api = window.electronAPI!;
    const result = await api.openFileDialog();
    if (result.canceled || !result.files.length) return;

    const newAttachments: Attachment[] = result.files.map(f => ({
      name: f.replace(/^.*[/\\]/, ''),
      path: f,
    }));
    setAttachments(prev => {
      const existingPaths = new Set(prev.map(a => a.path));
      const unique = newAttachments.filter(a => !existingPaths.has(a.path));
      return [...prev, ...unique];
    });
  }, []);

  // 移除附件
  const removeAttachment = useCallback((path: string) => {
    setAttachments(prev => prev.filter(a => a.path !== path));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;

    let text = trimmed;

    // 附件以 markdown 链接格式追加，AI 看到的是 [文件名](路径)
    if (attachments.length > 0) {
      if (text) text += '\n\n';
      text += attachments.map(a => `[${a.name}](${a.path})`).join('\n');
    }

    if (hasSelectedSkills) {
      const skillList = Array.from(selectedSkills).map(s => {
        const found = skillsList.find(sk => sk.name === s);
        return found ? found.name : s;
      });
      const skillStr = skillList.length === 1
        ? skillList[0]
        : skillList.join('、');
      text += `\n\n——为了完成这个工作，你需要调用${skillStr}技能。`;
    }

    onSend(text);
    setValue('');
    setAttachments([]);
    setSkillsOpen(false);
  }, [value, onSend, hasSelectedSkills, selectedSkills, attachments]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  useEffect(() => { setTimeout(() => textareaRef.current?.focus(), 300); }, []);

  return (
    <div className="input-bar">
      <div className="input-bar-body">
        <div className="input-wrapper">
          <div className="input-toolbar">
            <div className="capsule-group">
              <button
                className={`capsule-btn${smartSearchEnabled ? ' capsule-active' : ''}`}
                onClick={handleToggleSmartSearch}
                title={smartSearchEnabled ? '智能搜索（启用）：优先使用 Tavily 搜索' : '智能搜索（禁用）：使用普通搜索'}
              >
                <svg className="capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
                <span>智能搜索</span>
              </button>
              <button
                className={`capsule-btn${thinkingEnabled ? ' capsule-active' : ''}`}
                onClick={handleToggleThinking}
                title={thinkingEnabled ? '思考模式（启用）：AI 先展示推理过程再作答' : '思考模式（禁用）：直接作答'}
              >
                <svg className="capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/><path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z"/>
                </svg>
                <span>思考</span>
              </button>
              <button
                className={`capsule-btn${hasSelectedSkills ? ' capsule-active' : ''}`}
                onClick={toggleSkillsDropdown}
                title="选择要启用的技能"
                style={{ position: 'relative' }}
              >
                <svg className="capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                <span>{hasSelectedSkills ? `技能(${selectedSkills.size})` : '使用技能...'}</span>
              </button>
              <button
                className={`capsule-btn${kbEnabled ? ' capsule-active' : ''}`}
                onClick={onToggleKb}
                title={kbEnabled ? '知识库查询（启用）' : '知识库查询（禁用）'}
              >
                <svg className="capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                  <path d="M12 6v7"/><path d="M9 9.5h6"/>
                </svg>
                <span>知识库</span>
              </button>
            </div>
            <div className="input-toolbar-spacer" />
            <div className="input-actions">
              <button
                className="action-btn"
                title="添加附件"
                onClick={handleAttach}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
              </button>
              <button
                className={`send-btn${processing ? ' stop-mode' : ''}`}
                onClick={processing ? onAbort : handleSend}
                disabled={!processing && !value.trim() && attachments.length === 0}
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

          {attachments.length > 0 && (
            <div className="attachment-bar">
              {attachments.map(a => (
                <span key={a.path} className="attachment-chip">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="attachment-chip-icon">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                  <span className="attachment-chip-name" title={a.path}>{a.name}</span>
                  <button
                    className="attachment-chip-remove"
                    onClick={() => removeAttachment(a.path)}
                    title="移除附件"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="input-field-area">
            <textarea
              id="message-input"
              ref={textareaRef}
              rows={1}
              placeholder={attachments.length > 0 ? '添加消息描述（可选）…' : '给 DeepSeek 发送消息'}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {thinking && <div className="thinking-indicator" title="AI 思考中…">⠋</div>}
          </div>
        </div>
      </div>

      {skillsOpen && (
        <div className="skill-dropdown-overlay" onClick={() => setSkillsOpen(false)} />
      )}
      <div
        ref={dropdownRef}
        className={`skill-dropdown${skillsOpen ? ' open' : ''}`}
      >
        <div className="skill-dropdown-header">选择技能（复选）</div>
        <div className="skill-dropdown-list">
          {skillsList.map(skill => {
            const isSelected = selectedSkills.has(skill.name);
            return (
              <div
                key={skill.name}
                className={`skill-dropdown-item${isSelected ? ' selected' : ''}`}
                onClick={() => toggleSkill(skill.name)}
              >
                <svg className="skill-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  {isSelected ? (
                    <polyline points="20 6 9 17 4 12" />
                  ) : (
                    <circle cx="12" cy="12" r="10" />
                  )}
                </svg>
                <span className="skill-name">{inferSkillLabel(skill.name, skill.description)}</span>
                <span className="skill-key">{skill.name}</span>
              </div>
            );
          })}
        </div>
        {hasSelectedSkills && (
          <div className="skill-dropdown-footer">
            将在发送消息时追加: <code>——为了完成这个工作，你需要调用{Array.from(selectedSkills).map(s => skillsList.find(sk => sk.name === s)?.name ?? s).join('、')}技能。</code>
          </div>
        )}
      </div>
    </div>
  );
}










