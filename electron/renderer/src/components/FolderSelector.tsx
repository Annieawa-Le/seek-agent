import { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { WorkdirState } from '@/types/index.ts';

function dirName(dir: string): string {
  if (!dir) return 'select folder';
  return dir.split('\\').pop()?.split('/').pop() || dir;
}

function dirDisplay(dir: string): string {
  return dir.length > 55 ? '...' + dir.slice(-52) : dir;
}

/**
 * 工作区选择器（多选版）：一个会话可挂载多个工作区根，
 * 触发器显示当前活跃根名称 + 挂载数；菜单支持 设为活跃 / 移除 / 添加（最近目录 / Browse）。
 */
export function FolderSelector() {
  const { getWorkdir, setWorkspaceRoots, addWorkspaceRoot, removeWorkspaceRoot, selectFolder, getRecentDirs, onWorkdirChanged } = useElectronAPI();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WorkdirState>({ roots: [], active: '' });
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    getWorkdir().then(st => {
      if (st && Array.isArray(st.roots)) setState(st);
    });
    getRecentDirs().then(dirs => setRecentDirs(dirs));
  }, [getWorkdir, getRecentDirs]);

  useEffect(() => {
    const unsub = onWorkdirChanged((st: WorkdirState) => {
      if (st && Array.isArray(st.roots)) {
        setState(st);
      }
      getRecentDirs().then(dirs => setRecentDirs(dirs));
    });
    return () => unsub();
  }, [onWorkdirChanged, getRecentDirs]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 打开时计算 fixed 定位坐标（右对齐触发器，向上弹出——InputBar 在窗口底部）
  // 菜单经 createPortal 渲染到 body 下：.input-bar 的 backdrop-filter 会劫持 fixed 包含块、
  // 上层 #body-content/#main-content 的 overflow:hidden 会裁剪 absolute——只有 portal 能同时避开两者。
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      bottom: `${window.innerHeight - rect.top + 6}px`,
      right: `${window.innerWidth - rect.right}px`,
      zIndex: 99999,
    });
  }, [open]);

  /** 应用新的工作区状态（成功后同步本地 + 刷新最近目录） */
  const applyResult = useCallback(async (res: { success?: boolean; roots?: string[]; active?: string }) => {
    if (res?.success && Array.isArray(res.roots)) {
      setState({ roots: res.roots, active: res.active || res.roots[0] });
    }
    const dirs = await getRecentDirs();
    setRecentDirs(dirs);
  }, [getRecentDirs]);

  /** 点击目录项：设为活跃（保持挂载列表不变） */
  const handleActivate = useCallback(async (dir: string) => {
    const res = await setWorkspaceRoots({ roots: state.roots, active: dir });
    await applyResult(res);
    setOpen(false);
  }, [setWorkspaceRoots, state.roots, applyResult]);

  /** 追加挂载（若已挂载则改为设为活跃） */
  const handleAdd = useCallback(async (dir: string) => {
    if (state.roots.includes(dir)) {
      await handleActivate(dir);
      return;
    }
    const res = await addWorkspaceRoot(dir);
    await applyResult(res);
    setOpen(false);
  }, [addWorkspaceRoot, handleActivate, state.roots, applyResult]);

  /** 移除挂载 */
  const handleRemove = useCallback(async (e: React.MouseEvent, dir: string) => {
    e.stopPropagation();
    const res = await removeWorkspaceRoot(dir);
    await applyResult(res);
  }, [removeWorkspaceRoot, applyResult]);

  /** Browse 选择新目录：已挂载则设为活跃，否则添加 */
  const handleBrowse = useCallback(async () => {
    const result = await selectFolder();
    if (!result.canceled && result.path) {
      await handleAdd(result.path);
    } else {
      setOpen(false);
    }
  }, [selectFolder, handleAdd]);

  const { roots, active } = state;
  const activeName = dirName(active);
  const mountedPaths = new Set(roots);
  // 最近目录中尚未挂载的（已挂载的显示在 roots 列表，不重复）
  const availableRecent = recentDirs.filter(d => !mountedPaths.has(d));

  return (
    <span className="folder-selector">
      <span
        ref={triggerRef}
        className="ctx-folder"
        onClick={() => setOpen(v => !v)}
        title={roots.length > 1 ? `工作区（${roots.length}）：${roots.join('; ')}` : (active || '选择工作区目录')}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {activeName}
        {roots.length > 1 && <span className="folder-count-badge">{roots.length}</span>}
        <span className="dropdown-arrow">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </span>

      {open && createPortal(
        <div ref={menuRef} className="folder-menu" style={menuStyle}>
          <div className="folder-menu-section-title">工作区（{roots.length}）· 点击设为当前</div>
          <div className="folder-menu-items">
            {roots.length === 0 ? (
              <div className="folder-menu-empty">尚未选择工作区，从下方添加</div>
            ) : (
              roots.map(dir => {
                const isActive = dir === active;
                return (
                  <div
                    key={dir}
                    className={`folder-menu-item${isActive ? ' active' : ''}`}
                    onClick={() => handleActivate(dir)}
                    title={isActive ? '当前工作区' : `设为当前工作区：${dir}`}
                  >
                    <svg className="folder-menu-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {isActive ? (
                        <polyline points="20 6 9 17 4 12" />
                      ) : (
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      )}
                    </svg>
                    <div className="folder-menu-item-info">
                      <span className="folder-menu-item-name">
                        {dirName(dir)}
                        {isActive && <span className="folder-menu-active-tag">当前</span>}
                      </span>
                      <span className="folder-menu-item-path">{dirDisplay(dir)}</span>
                    </div>
                    <button
                      className="folder-menu-item-remove"
                      title="移除该工作区"
                      onClick={e => handleRemove(e, dir)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {availableRecent.length > 0 && (
            <>
              <div className="folder-menu-sep" />
              <div className="folder-menu-section-title">最近目录（点击添加）</div>
              <div className="folder-menu-items">
                {availableRecent.map(dir => (
                  <div
                    key={dir}
                    className="folder-menu-item"
                    onClick={() => handleAdd(dir)}
                    title={`添加工作区：${dir}`}
                  >
                    <svg className="folder-menu-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      <line x1="12" y1="11" x2="12" y2="17" />
                      <line x1="9" y1="14" x2="15" y2="14" />
                    </svg>
                    <div className="folder-menu-item-info">
                      <span className="folder-menu-item-name">{dirName(dir)}</span>
                      <span className="folder-menu-item-path">{dirDisplay(dir)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="folder-menu-sep" />

          <div className="folder-menu-item folder-menu-browse" onClick={handleBrowse}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            <span>添加文件夹…</span>
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}












