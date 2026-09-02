import { useState, useRef, useCallback, useEffect } from 'react';
import { isElectron } from '@/hooks/useElectronAPI.ts';
import { FolderSelector } from './FolderSelector.tsx';

interface Attachment {
  name: string;
  path: string;
  /** 来源类型：拖拽时区分文件/文件夹，仅影响 chip 图标 */
  type?: 'file' | 'folder';
}

interface Props {
  processing: boolean;
  /** 上下文 Token 数（原底部状态栏迁移而来，灰色小字显示在输入框下方） */
  ctxTokens: number;
  /** 会话累计 token 用量与缓存命中率（dsh 风格灰色小字） */
  usageSummary: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheHitRate: number | null };
  /** 当前会话 id：输入栏草稿（文本/附件/技能选择）按会话独立保存与恢复 */
  sessionKey: string;
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

/** 运行计时显示：毫秒 → 「N秒 / N分N秒」 */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return s % 60 > 0 ? `${m}分${s % 60}秒` : `${m}分`;
}

export function InputBar({
  sessionKey, processing, ctxTokens, usageSummary, thinking, kbEnabled, smartSearchEnabled, thinkingEnabled, skillsList,
  onSend, onAbort, onToggleKb, onToggleSmartSearch, onToggleThinking,
}: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── 运行计时：从上次发送到现在 ──
  const [elapsed, setElapsed] = useState(0);
  const [hasRun, setHasRun] = useState(false);
  // 会话累计用量是否已产生（任一桶非 0 才展示，避免空会话显示无意义“用量 ↑0 ↓0”）
  const hasUsage = usageSummary.inputTokens > 0 || usageSummary.outputTokens > 0 || usageSummary.cacheReadTokens > 0 || usageSummary.cacheWriteTokens > 0;
  const startAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevProcessingRef = useRef(processing);

  const stopRunTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  // processing 由 true → false（本轮回复完成）：停表并定格最终时长
  useEffect(() => {
    if (prevProcessingRef.current && !processing && startAtRef.current !== null) {
      setElapsed(Date.now() - startAtRef.current);
      stopRunTimer();
    }
    prevProcessingRef.current = processing;
  }, [processing, stopRunTimer]);

  // 卸载时清理计时器
  useEffect(() => () => stopRunTimer(), [stopRunTimer]);

  // 输入栏草稿按会话隔离：sessionKey → { value, attachments, selectedSkills }
  const draftsRef = useRef<Map<string, { value: string; attachments: Attachment[]; selectedSkills: Set<string> }>>(new Map());
  const prevSessionRef = useRef<string | null>(null);

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

  // 切换会话：保存上一个会话的草稿，恢复当前会话的草稿（空会话重置输入栏）
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev !== null && prev !== sessionKey) {
      if (value.trim() || attachments.length > 0 || selectedSkills.size > 0) {
        draftsRef.current.set(prev, { value, attachments, selectedSkills });
      }
    }
    const draft = draftsRef.current.get(sessionKey);
    if (draft) {
      setValue(draft.value);
      setAttachments(draft.attachments);
      setSelectedSkills(draft.selectedSkills);
    } else {
      setValue('');
      setAttachments([]);
      setSelectedSkills(new Set());
    }
    prevSessionRef.current = sessionKey;
    setSkillsOpen(false);
    // 切换会话后重新聚焦输入框
    setTimeout(() => textareaRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

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
      type: 'file',
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

  // ── 拖拽附件（从右侧文件树或系统文件管理器拖入）──
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // 阻止默认行为，允许放置
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragEnter = useCallback(() => {
    dragDepthRef.current += 1;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);

    const items: Attachment[] = [];
    // 应用内拖拽（右侧文件树）：自定义 MIME 携带 { path, name, type }
    const custom = e.dataTransfer.getData('application/x-seek-attach');
    if (custom) {
      try {
        const parsed = JSON.parse(custom);
        if (parsed?.path) {
          items.push({
            name: parsed.name || parsed.path.replace(/^.*[/\\]/, ''),
            path: parsed.path,
            type: parsed.type === 'folder' ? 'folder' : 'file',
          });
        }
      } catch { /* 非 JSON 忽略 */ }
    }
    // 外部拖入（系统文件管理器）：Electron 为 File 挂载 path，文件夹同样适用
    if (items.length === 0) {
      for (const f of Array.from(e.dataTransfer.files || [])) {
        const p = (f as File & { path?: string }).path;
        if (p) items.push({ name: f.name, path: p, type: 'file' });
      }
    }
    if (items.length === 0) return;
    setAttachments(prev => {
      const existingPaths = new Set(prev.map(a => a.path));
      const unique = items.filter(a => !existingPaths.has(a.path));
      return [...prev, ...unique];
    });
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
    // 开始/重置运行计时（从本次发送起算）
    setHasRun(true);
    startAtRef.current = Date.now();
    setElapsed(0);
    stopRunTimer();
    timerRef.current = setInterval(() => {
      if (startAtRef.current !== null) setElapsed(Date.now() - startAtRef.current);
    }, 1000);
    setValue('');
    setAttachments([]);
    setSkillsOpen(false);
  }, [value, onSend, hasSelectedSkills, selectedSkills, attachments, stopRunTimer]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  useEffect(() => { setTimeout(() => textareaRef.current?.focus(), 300); }, []);

  return (
    <div className="input-bar">
      <div className="input-bar-body">
        <div
          className={`input-wrapper${dragOver ? ' drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
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
              <FolderSelector />
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
                  {a.type === 'folder' ? (
                    <span className="attachment-chip-icon attachment-chip-folder">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </span>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="attachment-chip-icon">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    </svg>
                  )}
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
            {thinking && <div className="thinking-indicator" title="AI 思考中…" />}
          </div>
        </div>
        <div className="input-meta">
          {ctxTokens > 0 && <span className="input-meta-stat">Token {ctxTokens}</span>}
          {hasUsage && <span className="input-meta-stat" title="会话累计 token 用量（↑未缓存输入 ↓输出）· 缓存命中率">用量 ↑{usageSummary.inputTokens} ↓{usageSummary.outputTokens}{usageSummary.cacheHitRate != null ? ` 缓存${usageSummary.cacheHitRate}%` : ''}</span>}
          {hasRun && <span className="input-meta-stat">运行 {formatElapsed(elapsed)}</span>}
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









































