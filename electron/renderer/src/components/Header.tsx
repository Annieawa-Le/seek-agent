import { useState, useEffect } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { AgentStatusState } from '@/hooks/useAgentStatus.ts';
import { Tabs } from './Tabs.tsx';
import type { TabItem } from '@/types/index.ts';

interface Props {
  status: AgentStatusState;
  panelOpen: boolean;
  onTogglePanel: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  /** 标签页数据（对应已打开会话） */
  tabs: TabItem[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  onTabNew: () => void;
  /** 文件拖入标签页栏：在内嵌编辑器中打开（新标签页） */
  onDropFile?: (file: { path: string; name: string; type: 'file' | 'folder' }) => void;
}

const dotClass: Record<string, string> = {
  connected: 'status-dot connected',
  disconnected: 'status-dot disconnected',
  connecting: 'status-dot disconnected',
};

export function Header({ status, theme, onToggleTheme, onOpenSettings, onToggleSidebar, sidebarOpen, panelOpen, onTogglePanel, tabs, activeTabId, onTabSelect, onTabClose, onTabNew, onDropFile }: Props) {
  const api = useElectronAPI();
  const { minimizeWindow, maximizeWindow, closeWindow, onMaximizedChange, isWindowMaximized } = api;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    isWindowMaximized().then(setIsMaximized);
    const unsub = onMaximizedChange(setIsMaximized);
    return () => unsub();
  }, [isWindowMaximized, onMaximizedChange]);

  const dotCls = dotClass[status.connectionState] || 'status-dot disconnected';

  return (
    <header id="header">
      <div className="header-left">
        <button className={`sidebar-toggle${sidebarOpen ? ' active' : ''}`} onClick={onToggleSidebar} title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <span className="header-icon" role="img" aria-label="Seek Agent" /><span className="header-title-img" role="img" aria-label="Seek Agent" />
      </div>

      <div className="header-center">
        <Tabs
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={onTabSelect}
          onClose={onTabClose}
          onNew={onTabNew}
          onDropFile={onDropFile}
        />
      </div>

      <div className="header-right">
        <button className={`panel-toggle${panelOpen ? ' active' : ''}`} onClick={onTogglePanel} title={panelOpen ? '收起右侧栏' : '展开右侧栏'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>
          </svg>
        </button>

        <button className="theme-toggle" onClick={onToggleTheme}
          title={theme === 'dark' ? '切换亮色模式' : '切换暗色模式'}>
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>

        <button className="settings-toggle" onClick={onOpenSettings} title="设置">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <span className={dotCls} title={status.connectionState} />

        <div className="window-controls">
          <button className="win-btn win-btn-minimize" onClick={minimizeWindow} title="最小化">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>
          </button>
          <button className="win-btn win-btn-maximize" onClick={maximizeWindow} title={isMaximized ? '还原' : '最大化'}>
            {isMaximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="3" y="0.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
                <rect x="0.5" y="3" width="8" height="8" rx="1" fill="var(--bg-base)" stroke="currentColor" strokeWidth="1"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
              </svg>
            )}
          </button>
          <button className="win-btn win-btn-close" onClick={closeWindow} title="关闭">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}


















