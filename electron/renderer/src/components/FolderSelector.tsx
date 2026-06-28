import { useState, useEffect, useRef, useCallback } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';

export function FolderSelector() {
  const { getWorkdir, setWorkdir, selectFolder, getRecentDirs, onWorkdirChanged } = useElectronAPI();

  const [open, setOpen] = useState(false);
  const [workdir, setWorkdirState] = useState('');
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getWorkdir().then(dir => setWorkdirState(dir));
    getRecentDirs().then(dirs => setRecentDirs(dirs));
  }, [getWorkdir, getRecentDirs]);

  useEffect(() => {
    const unsub = onWorkdirChanged((path: string) => {
      setWorkdirState(path);
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

  // 打开时计算固定定位坐标
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
      zIndex: 99999,
    });
  }, [open]);

  const handleSelect = useCallback(async (dir: string) => {
    const result = await setWorkdir(dir);
    if (result.success) {
      setWorkdirState(result.path!);
      const dirs = await getRecentDirs();
      setRecentDirs(dirs);
    }
    setOpen(false);
  }, [setWorkdir, getRecentDirs]);

  const handleBrowse = useCallback(async () => {
    const result = await selectFolder();
    if (!result.canceled && result.path) {
      await handleSelect(result.path);
    } else {
      setOpen(false);
    }
  }, [selectFolder, handleSelect]);

  const folderName = workdir
    ? workdir.split('\\').pop()?.split('/').pop() || workdir
    : 'select folder';

  return (
    <span className="folder-selector">
      <span
        ref={triggerRef}
        className="ctx-folder"
        onClick={() => setOpen(v => !v)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: 3 }}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {folderName}
        <span className="dropdown-arrow">▼</span>
      </span>

      {open && (
        <div ref={menuRef} className="folder-menu" style={menuStyle}>
          {workdir && (
            <div className="folder-menu-current">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <div className="folder-menu-current-info">
                <span className="folder-menu-current-name">{folderName}</span>
                <span className="folder-menu-current-path">{workdir}</span>
              </div>
            </div>
          )}

          <div className="folder-menu-items">
            {recentDirs.length === 0 ? (
              <div className="folder-menu-empty">No recent directories</div>
            ) : (
              recentDirs.map((dir, i) => {
                const name = dir.split('\\').pop()?.split('/').pop() || dir;
                const displayPath = dir.length > 55 ? '...' + dir.slice(-52) : dir;
                return (
                  <div
                    key={i}
                    className={`folder-menu-item${dir === workdir ? ' active' : ''}`}
                    onClick={() => handleSelect(dir)}
                  >
                    <svg className="folder-menu-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <div className="folder-menu-item-info">
                      <span className="folder-menu-item-name">{name}</span>
                      <span className="folder-menu-item-path">{displayPath}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="folder-menu-sep" />

          <div className="folder-menu-item folder-menu-browse" onClick={handleBrowse}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            <span>Browse...</span>
          </div>
        </div>
      )}
    </span>
  );
}

