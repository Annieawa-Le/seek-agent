import { useEffect, useRef, useState } from 'react';
import { normPath, type ChangedFile } from '@/hooks/useFilePatches.ts';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { TYPE_LABEL, baseName, formatClock, shortPath } from '@/utils/display-format.ts';

/* ═══════════════════════════════════════════════════════════
   审查浮球（编辑器右下角悬浮）
   - 圆形悬浮按钮：点击浮现上拉列表，列出「距上次审查」以来 AI 改动过的文件
   - 按钮左右浮现 ‹ › 切换按钮：快速跳到上一个 / 下一个改动文件
   - 审查模式本身（文件内的内联差异）由 FileEditor 渲染，这里只负责导航与开关

   纯展示组件：数据由 useFilePatches 在 FileEditor 里取得后透传下来。
   ═══════════════════════════════════════════════════════════ */

interface Props {
  /** 当前编辑器打开的文件绝对路径 */
  activePath: string;
  /** 距上次审查改动过的文件（最近改动在前） */
  files: ChangedFile[];
  error: string | null;
  /** 审查模式开关由宿主持有：切换文件时编辑器会重挂载，状态不能放在这里 */
  reviewMode: boolean;
  onReviewModeChange: (open: boolean) => void;
  /** 切换到某文件：由宿主打开对应标签页 */
  onOpenFile?: (absPath: string) => void;
  onRefresh: () => void;
  /** 标记某个文件已审查（只抬该文件的水位线，不动其它文件） */
  onFinishFile: (path: string) => void;
  /** 标记全部文件已审查（上拉列表底部的动作） */
  onFinishAll: () => void;
  /** 回退成功后通知宿主重载文件内容（磁盘上的文件已变） */
  onUndoDone?: () => void;
}

export function ReviewDock({
  activePath, files, error, reviewMode, onReviewModeChange, onOpenFile, onRefresh, onFinishFile, onFinishAll, onUndoDone,
}: Props) {
  const { undoPatch } = useElectronAPI();
  const [menuOpen, setMenuOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement | null>(null);

  const activeIndex = files.findIndex(f => normPath(f.path) === normPath(activePath));
  /** 当前文件是否有待审查的改动（决定上下两个动作按钮能否点） */
  const hasPendingForActive = activeIndex >= 0 && files[activeIndex].records.length > 0;

  /** 切换到相邻改动文件（列表首尾循环） */
  const step = (dir: -1 | 1) => {
    if (files.length === 0) return;
    // 当前文件不在列表里时：向右从第一个开始，向左落到最后一个
    const base = activeIndex >= 0 ? activeIndex : (dir > 0 ? -1 : 0);
    onOpenFile?.(files[(base + dir + files.length) % files.length].path);
  };

  /** 打开某个改动文件并直接进入审查模式 */
  const openInReview = (path: string) => {
    onOpenFile?.(path);
    onReviewModeChange(true);
    setMenuOpen(false);
  };

  /**
   * 回退：撤掉「当前文件」最近一条改动记录（Ctrl+Z 语义）。
   *
   * 必须带上 recordId 并锁定到当前文件——不带参数时主进程会从全局记录里
   * 往回找第一条能还原的，可能一次跨过别的文件，甚至越过当前文件的好几条改动。
   */
  const [undoing, setUndoing] = useState(false);
  const undo = async () => {
    if (undoing) return;
    const target = files.find(f => normPath(f.path) === normPath(activePath));
    if (!target || target.records.length === 0) return;
    // records 按时间倒序（主进程返回顺序），首条即该文件最近一次改动
    const latest = target.records.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));

    setUndoing(true);
    try {
      const res = await undoPatch({ recordId: latest.id });
      if (res?.ok === false) {
        // 定位失败属于正常情况（内容被后续改动覆盖过），不打扰用户
        if (res.error) console.warn('[review] undo failed:', res.error);
      } else {
        onRefresh();
        onUndoDone?.();
      }
    } finally {
      setUndoing(false);
    }
  };

  // 点击浮球外部收起上拉列表
  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (dockRef.current && !dockRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [menuOpen]);

  const showSteps = files.length > 1 && (menuOpen || reviewMode);
  /** 确认 / 回退两个动作按钮：只在审查模式激活时出现（浮球上下各一枚） */
  const showActions = !!reviewMode;

  return (
    <div className={`review-dock${menuOpen ? ' open' : ''}${showSteps ? ' with-steps' : ''}`} ref={dockRef}>
      {menuOpen && (
        <div className="review-menu">
          <div className="review-menu-head">
            <span className="review-menu-title">AI 改动</span>
            <span className="review-menu-count">{files.length} 个文件</span>
            <button className="review-menu-refresh" title="刷新" onClick={onRefresh}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>

          <div className="review-menu-list">
            {error ? (
              <div className="review-menu-empty">{error}</div>
            ) : files.length === 0 ? (
              <div className="review-menu-empty">上次审查之后暂无改动</div>
            ) : files.map(f => (
              <div
                key={normPath(f.path)}
                className={`review-item${normPath(f.path) === normPath(activePath) ? ' active' : ''}`}
                onClick={() => openInReview(f.path)}
                title={f.path}
              >
                <span className={`review-item-type ${f.lastType}`}>{TYPE_LABEL[f.lastType] || f.lastType}</span>
                <div className="review-item-body">
                  <div className="review-item-top">
                    <span className="review-item-name">{baseName(f.path)}</span>
                    {f.count > 1 && <span className="review-item-times">×{f.count}</span>}
                    <span className="review-item-time">{formatClock(f.lastTs)}</span>
                  </div>
                  <div className="review-item-dir">{shortPath(f.path)}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="review-menu-foot">
            <button
              className="review-btn-finish"
              onClick={() => { onFinishAll(); setMenuOpen(false); }}
              disabled={files.length === 0}
            >
              全部标记已审查
            </button>
            {reviewMode && (
              <button className="review-btn-mode" onClick={() => { onReviewModeChange(false); setMenuOpen(false); }}>
                退出审查
              </button>
            )}
          </div>
        </div>
      )}

      {showSteps && (
        <>
          <button className="review-step prev" title="上一个改动文件" onClick={() => step(-1)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button className="review-step next" title="下一个改动文件" onClick={() => step(1)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </>
      )}

      {/* 浮球上方：确认 —— 只标记「当前文件」已审查，不影响其它待审文件 */}
      {showActions && (
        <button
          className="review-action review-action-confirm"
          title={files.length === 0 ? '当前文件没有待审查的改动'
            : `标记「${baseName(activePath)}」已审查（其它 ${Math.max(files.length - 1, 0)} 个文件不受影响）`}
          disabled={!hasPendingForActive}
          onClick={() => { onFinishFile(activePath); setMenuOpen(false); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      )}

      {/* 浮球下方：回退 —— 撤销「当前文件」最近一条改动（Ctrl+Z 语义） */}
      {showActions && (
        <button
          className="review-action review-action-undo"
          title={hasPendingForActive ? `回退「${baseName(activePath)}」最近一次改动` : '当前文件没有可回退的改动'}
          disabled={undoing || !hasPendingForActive}
          onClick={undo}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 14 4 9 9 4" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
        </button>
      )}

      <button
        className={`review-fab${reviewMode ? ' active' : ''}`}
        title="审查 AI 改动"
        onClick={() => { setMenuOpen(o => !o); onRefresh(); }}
      >
        {/* 图标：堆叠的文件 */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 2.5h7l4 4v8" opacity="0.5" />
          <path d="M4 5.5h7l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z" />
          <polyline points="11 5.5 11 9.5 15 9.5" />
          <line x1="6.5" y1="13.5" x2="12.5" y2="13.5" />
          <line x1="6.5" y1="16.5" x2="10.5" y2="16.5" />
        </svg>
        {files.length > 0 && <span className="review-fab-badge">{files.length}</span>}
      </button>
    </div>
  );
}



