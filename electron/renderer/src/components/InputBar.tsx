import { useState, useRef, useCallback, useEffect } from 'react';

interface Props {
  processing: boolean;
  thinking: boolean;
  kbEnabled: boolean;
  smartSearchEnabled: boolean;
  skillsList: Array<{ name: string; description: string }>;
  onSend: (text: string) => void;
  onAbort: () => void;
  onToggleKb: () => void;
  onToggleSmartSearch: (enabled: boolean) => void;
}

/**
 * 从技能名生成短标签
 * 如 "github-api-design" → "API 设计", "html-toolkit" → "HTML 工具", "kb-query" → "知识库"
 * 优先从 description 中提取，否则从 name 推断
 */
function inferSkillLabel(name: string, description: string): string {
  // 如果 description 有有意义的中文内容，取前半段
  const descMatch = description.match(/^[\u4e00-\u9fff\w\s]+/);
  const descLabel = descMatch ? descMatch[0].trim() : '';
  if (descLabel.length >= 4 && descLabel.length <= 20) return descLabel;

  // 从 name 推断
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
  processing, thinking, kbEnabled, smartSearchEnabled, skillsList,
  onSend, onAbort, onToggleKb, onToggleSmartSearch,
}: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 技能上拉列表状态
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(36, el.scrollHeight) + 'px';
  }, []);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  // 点击外部关闭技能下拉
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

  // 切换智能搜索
  const handleToggleSmartSearch = useCallback(() => {
    onToggleSmartSearch(!smartSearchEnabled);
  }, [smartSearchEnabled, onToggleSmartSearch]);

  // 切换技能下拉
  const toggleSkillsDropdown = useCallback(() => {
    setSkillsOpen(prev => !prev);
  }, []);

  // 切换技能选中
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

  // 是否有技能被选中
  const hasSelectedSkills = selectedSkills.size > 0;

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;

    let text = trimmed;
    // 如果有选中的技能，追加技能提示
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
    setSkillsOpen(false);
  }, [value, onSend, hasSelectedSkills, selectedSkills]);

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

      {/* —— 技能上拉列表 —— */}
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












