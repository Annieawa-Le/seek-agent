import { useState, useEffect, useCallback } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { SessionInfo } from '@/types/index.ts';

interface Props {
  onNewSession: () => void;
}

const customItems = [
  { key: 'agents', label: 'Agents', icon: 'M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4zM2 22v-2a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6v2' },
  { key: 'skills', label: 'Skills', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { key: 'instructions', label: 'Instructions', icon: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z' },
  { key: 'hooks', label: 'Hooks', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
  { key: 'mcp', label: 'MCP Servers', icon: 'M8 3v14M12 3v14M4 21h16' },
  { key: 'plugins', label: 'Plugins', icon: 'M20 12H4M12 4v16' },
];

const subItemsMap: Record<string, string[]> = {
  agents: ['seek-agent', 'custom-agent'],
  skills: ['code-reader', 'web-accessor', 'html-toolkit', 'image-identifier', 'pdf-reader'],
  instructions: ['system-prompt', 'user-prompt'],
  hooks: ['pre-message', 'post-message', 'on-error'],
  mcp: ['file-server', 'search-server'],
  plugins: ['plugin-a', 'plugin-b'],
};

export function LeftSidebar({ onNewSession }: Props) {
  const { listSessions, sendCommand } = useElectronAPI();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [expandedCustom, setExpandedCustom] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [customCollapsed, setCustomCollapsed] = useState(false);

  const loadSessions = useCallback(async () => {
    const data = await listSessions();
    if (Array.isArray(data)) setSessions(data);
  }, [listSessions]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const handleNewSession = () => { onNewSession(); loadSessions(); };

  return (
    <aside id="left-sidebar">
      <div className="sidebar-section-header">
        <span className="section-title">Sessions</span>
        <div className="section-actions">
          <button className="section-action-btn" title="面板/分屏"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
          <button className="section-action-btn" title="搜索"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
        </div>
      </div>

      <button id="new-session-btn" className="new-session-btn" onClick={handleNewSession}>
        <span className="ns-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
        <span className="ns-text">New</span>
        <span className="ns-shortcut">Ctrl+N</span>
      </button>

      <div id="session-list" className="session-list">
        {sessions.length === 0 ? <div className="session-empty">暂无会话</div> : sessions.map(s => {
          const timeStr = s.timestamp ? new Date(s.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
          return (
            <div key={s.name} className={`session-item${activeSession === s.name ? ' active' : ''}`} onClick={() => setActiveSession(s.name)}>
              <div className="session-name">{s.name}</div>
              <div className="session-meta">{s.messageCount} msgs{timeStr ? ` · ${timeStr}` : ''}</div>
              {s.preview && <div className="session-preview">{s.preview.slice(0, 60)}</div>}
            </div>
          );
        })}
      </div>

      <div id="sidebar-spacer" />

      <div id="customizations-section">
        <div className="sidebar-section-header collapsible" onClick={() => setCustomCollapsed(v => !v)}>
          <span className="section-title">Customizations</span>
          <span className="collapse-arrow">{customCollapsed ? '▶' : '▼'}</span>
        </div>

        {!customCollapsed && (
          <ul id="custom-list">
            {customItems.map(item => (
              <li key={item.key} className="custom-item" data-expandable="true" onClick={(e) => { e.stopPropagation(); setExpandedCustom(prev => prev === item.key ? null : item.key); }}>
                <svg className="custom-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={item.icon} /></svg>
                <span className="custom-label">{item.label}</span>
                {item.key === 'skills' && <span className="custom-badge">10</span>}
                {item.key === 'mcp' && <span className="custom-badge">2</span>}
                <span className={`custom-expand${expandedCustom === item.key ? ' expanded' : ''}`}>{expandedCustom === item.key ? '▼' : '▶'}</span>
              </li>
            ))}
          </ul>
        )}

        {expandedCustom && !customCollapsed && (
          <div className="custom-subitems">
            {(subItemsMap[expandedCustom] || []).map(name => (
              <div key={name} className="custom-subitem"><span className="custom-subicon">·</span>{name}</div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
