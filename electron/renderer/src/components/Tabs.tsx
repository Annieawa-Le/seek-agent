import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TabItem } from '@/types/index.ts';

/**
 * 标签页派生视图：把统一的 TabItem 列表映射为会话标签 + 文件标签。
 * 「+」按钮只属于会话侧，故拼在会话标签末尾，位置与关闭/切换行为都按会话语义处理。
 */
interface TabView {
  key: string;
  label: string;
  /** 数据来源标签（onSelect/onClose 回传此值，而非 key） */
  source: TabItem;
  /** 「+」新建会话按钮槽位 */
  isNew?: boolean;
}



interface Props {
  tabs: TabItem[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** 文件拖入标签页栏：回传自定义 MIME 载荷（与右侧面板拖拽同源） */
  onDropFile?: (payload: { path: string; name: string; type: 'file' | 'folder' }) => void;
}

/** 标题栏中间区域的浏览器风格标签页（会话标签 + 文件编辑器标签，VSCode 式混排） */
export function Tabs({ tabs, activeTabId, onSelect, onClose, onNew, onDropFile }: Props) {
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  /** 文件拖拽悬停高亮（仅当载荷为工作区文件时点亮） */
  const [dropActive, setDropActive] = useState(false);

  const views: TabView[] = useMemo(() => {
    const sessionViews = tabs.filter(t => t.kind !== 'file');
    const fileViews = tabs.filter(t => t.kind === 'file');
    return [
      ...sessionViews.map(t => ({ key: t.id, label: t.title, source: t })),
      { key: '__new_session__', label: '', source: { id: '__new_session__', title: '新建会话', kind: 'session' as const }, isNew: true },
      ...fileViews.map(t => ({ key: t.id, label: t.title, source: t })),
    ];
  }, [tabs]);

  // 跟踪滚动容器宽度，供等宽均分计算使用（窗口缩放/侧栏开关都会影响）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 手动均分标签宽度：flex 弹性布局的收缩是布局引擎算的，transition 捕获不到，
  // 改为 JS 算出目标宽度写入 width 属性，增删标签时宽度就能平滑过渡
  const tabWidth = useMemo(() => {
    const n = views.length;
    if (n === 0 || containerWidth === 0) return 200;
    const GAP = 2; // 标签间 flex gap
    const available = containerWidth - GAP * n;
    // 会话标签均分宽度、上限 200px；文件标签走 CSS 自适应宽度（名字长短不一，等分会把长名挤没）
    const sessionCount = Math.max(1, views.filter(v => v.source.kind !== 'file').length);
    return Math.max(60, Math.min(200, Math.round(available / sessionCount)));
  }, [containerWidth, views]);
  // 活动标签变化时滚到可见区域（浏览器行为：切到远处标签平滑滚过去，标签位置不重排）
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  /** 拖拽载荷：仅接受工作区文件/文件夹（右侧面板下发的自定义 MIME） */
  const readDragPayload = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-seek-attach');
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return typeof data?.path === 'string' && data.path ? data : null;
    } catch {
      return null;
    }
  };

  // dragenter/dragleave 会在子元素间反复冒泡，用计数器判定真正离开标签栏
  const dragDepth = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-seek-attach')) return;
    dragDepth.current += 1;
    setDropActive(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-seek-attach')) return;
    e.preventDefault(); // 声明可放置（否则 drop 不触发）
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    dragDepth.current = 0;
    setDropActive(false);
    const payload = readDragPayload(e);
    if (!payload) return;
    e.preventDefault();
    onDropFile?.({ path: payload.path, name: payload.name || payload.path, type: payload.type === 'folder' ? 'folder' : 'file' });
  };

  return (
    <div
      className={`header-tabs${dropActive ? ' drop-active' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="header-tabs-scroll" ref={scrollRef}>
        {views.map(view => {
          const isActive = view.source.id === activeTabId;
          const isFile = view.source.kind === 'file';
          return (
            <div
              key={view.key}
              ref={isActive ? activeTabRef : undefined}
              className={`header-tab${isActive ? ' active' : ''}${isFile ? ' file-tab' : ''}${view.isNew ? ' new-tab' : ''}`}
              style={{ width: view.isNew ? 26 : isFile ? undefined : tabWidth }}
              onClick={() => (view.isNew ? onNew() : onSelect(view.source.id))}
              title={view.isNew ? '新建会话' : view.source.title}
            >
              {view.isNew ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              ) : (
                <>
                  {isFile && <span className="header-tab-dot" aria-hidden="true" />}
                  <span className="header-tab-title">{view.source.title}</span>
                  <button
                    className="header-tab-close"
                    title="关闭标签页"
                    onClick={(e) => { e.stopPropagation(); onClose(view.source.id); }}
                  >
                    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                      <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}






