import { useEffect, useRef } from 'react';

export interface TabItem {
  id: string;
  title: string;
}

interface Props {
  tabs: TabItem[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

/** 标题栏中间区域的浏览器风格标签页（对应已打开会话，为后续页面管理打底） */
export function Tabs({ tabs, activeTabId, onSelect, onClose, onNew }: Props) {
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  // 活动标签变化时滚到可见区域（浏览器行为：切到远处标签平滑滚过去，标签位置不重排）
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  return (
    <div className="header-tabs">
      <div className="header-tabs-scroll">
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              ref={isActive ? activeTabRef : undefined}
              className={`header-tab${isActive ? ' active' : ''}`}
              onClick={() => onSelect(tab.id)}
              title={`切换到 ${tab.title}`}
            >
              <span className="header-tab-title">{tab.title}</span>
              <button
                className="header-tab-close"
                title="关闭标签页"
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              >
                <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                  <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
        <button className="header-tab-new" title="新建标签页" onClick={onNew}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

