import { useState, useEffect, useCallback, Fragment } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { ChatThreadData, CollabLogEntry, FileTreeNode, GitChange, RemoteDeviceInfo, SidebarRuntimeData, SubagentStreamMsg } from '@/types/index.ts';
import { SubagentNotePanel } from './SubagentNotePanel.tsx';
import { MemoryPanel } from './MemoryPanel.tsx';

const tagClassMap: Record<string, string> = { js: 'tag-yellow', ts: 'tag-blue', json: 'tag-yellow', npm: 'tag-red', mjs: 'tag-yellow', cjs: 'tag-yellow' };
const tagLabelMap: Record<string, string> = { json: '{}', npmrc: 'npm' };

let dragImageEl: HTMLElement | null = null;

function cleanupDragImage() {
  dragImageEl?.remove();
  dragImageEl = null;
}

/** 拖拽文件/文件夹节点：写入自定义 MIME（JSON），供输入框 drop 解析为附件 */
function handleNodeDragStart(e: React.DragEvent, node: FileTreeNode) {
  e.dataTransfer.setData('application/x-seek-attach', JSON.stringify({ path: node.absPath || node.path, name: node.name, type: node.type }));
  e.dataTransfer.setData('text/plain', node.absPath || node.path);
  e.dataTransfer.effectAllowed = 'copy';

  // 自定义拖拽图像：图标 + 文件名小卡片，替代默认的条目半透明快照
  cleanupDragImage();
  const img = document.createElement('div');
  img.style.cssText = [
    'position: fixed',
    'left: -9999px',
    'top: 0',
    'display: flex',
    'align-items: center',
    'gap: 6px',
    'padding: 5px 10px',
    'border-radius: 8px',
    'background: rgba(22, 18, 14, 0.92)',
    'border: 1px solid rgba(212, 168, 67, 0.45)',
    'color: #e8e0d0',
    'font-size: 12px',
    'max-width: 240px',
    'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35)',
    'pointer-events: none',
    'z-index: 99999',
    'white-space: nowrap',
  ].join(';');
  const icon = document.createElement('span');
  icon.style.cssText = 'font-size: 15px; line-height: 1; flex-shrink: 0; display: inline-flex;';
  icon.innerHTML = node.type === 'folder'
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const label = document.createElement('span');
  label.style.cssText = 'overflow: hidden; text-overflow: ellipsis;';
  dragImageEl = img;
  e.dataTransfer.setDragImage(img, 10, 10);
  window.addEventListener('dragend', cleanupDragImage, { once: true });
}

type PanelTab = 'files' | 'changes' | 'collab' | 'devices' | 'memory';
export function RightPanel({ runtimeData, open }: { runtimeData: SidebarRuntimeData | null; open?: boolean }) {
  const { readGitStatus } = useElectronAPI();
  const [currentTab, setCurrentTab] = useState<PanelTab>('files');
  const [gitChanges, setGitChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(false);

  const loadGitChanges = useCallback(async () => {
    setLoading(true);
    const data = await readGitStatus();
    if (Array.isArray(data)) setGitChanges(data);
    setLoading(false);
  }, [readGitStatus]);

  useEffect(() => {
    if (currentTab === 'changes') loadGitChanges();
  }, [currentTab, loadGitChanges]);

  return (
    <aside id="info-panel" className={open === false ? 'info-panel-closed' : open ? 'info-panel-open' : undefined}>
      <div className="panel-tabs">
        <span className={`panel-tab${currentTab === 'files' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('files')}>文件</span>
        <span className={`panel-tab${currentTab === 'changes' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('changes')}>改动</span>
        <span className={`panel-tab${currentTab === 'collab' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('collab')}>协作</span>
        <span className={`panel-tab${currentTab === 'devices' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('devices')}>设备</span>
        <span className={`panel-tab${currentTab === 'memory' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('memory')}>记忆</span>
        <div className="panel-tab-actions">
          <button className="panel-tab-btn" title="搜索"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
          <button className="panel-tab-btn" title="面板布局"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
        </div>
      </div>
      <div id="panel-content">
        {currentTab === 'files' && <FileTabContent />}
        {currentTab === 'changes' && (loading ? <div className="file-tree-loading">加载中…</div> : <GitChangesContent changes={gitChanges} />)}
        {currentTab === 'collab' && <CollabContent runtimeData={runtimeData} />}
        {currentTab === 'devices' && <DevicesContent />}
        {currentTab === 'memory' && <MemoryPanel runtimeData={runtimeData} />}
      </div>
    </aside>
  );
}

/* ═══════════════════════════════════════════════════════════
   文件面板：工作区根列表 + 目录浏览
   - 第一层 = 所有挂载工作区根目录（默认收起，点击展开显示该根第一层子项）
   - 更深层级不再树式展开：点击子文件夹进入独立浏览视图（面包屑导航逐层进入）
   ═══════════════════════════════════════════════════════════ */

interface WorkspaceRootEntry { name: string; path: string; active: boolean; }
/** 浏览位置：root = 工作区根绝对路径；segs = 从根算起的相对目录段（空数组 = 根本身） */
interface BrowsePos { root: string; segs: string[]; }

/** 绝对路径拼接（浏览任意挂载根时：root 绝对 + 相对段，/ 分隔 Node 端可解析） */
function joinAbs(root: string, segs: string[]): string {
  return segs.length ? `${root}/${segs.join('/')}` : root;
}

/** 路径末段（工作区根显示名） */
function pathBase(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function FileTabContent() {
  const { readFileTree, getWorkdir, onWorkdirChanged } = useElectronAPI();
  const [roots, setRoots] = useState<WorkspaceRootEntry[]>([]);
  /** 当前展开的工作区根（默认全部收起） */
  const [expandedRoot, setExpandedRoot] = useState<string | null>(null);
  /** 各工作区根的第一层子项缓存（避免反复请求） */
  const [rootTop, setRootTop] = useState<Record<string, FileTreeNode[]>>({});
  const [rootLoading, setRootLoading] = useState<string | null>(null);
  /** 目录浏览位置（null = 根列表视图） */
  const [pos, setPos] = useState<BrowsePos | null>(null);
  const [items, setItems] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  /** 视图切换动画方向：进入 fwd（右滑入）/ 返回 back（左滑入） */
  const [moveDir, setMoveDir] = useState<'fwd' | 'back'>('fwd');

  // 工作区列表：挂载时拉取 + 订阅根挂载变更（新增/移除/活跃切换实时刷新）
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const wd = await getWorkdir();
        if (!alive || !wd?.roots) return;
        setRoots(wd.roots.map(r => ({ name: pathBase(r), path: r, active: r === wd.active })));
      } catch { /* 保留旧列表 */ }
    };
    load();
    const unsub = onWorkdirChanged(() => load());
    return () => { alive = false; unsub(); };
  }, [getWorkdir, onWorkdirChanged]);

  /** 展开/收起工作区根；首次展开懒加载第一层子项（只拉一层，不递归） */
  const toggleRoot = async (root: string) => {
    if (expandedRoot === root) { setExpandedRoot(null); return; }
    setExpandedRoot(root);
    if (!rootTop[root]) {
      setRootLoading(root);
      try {
        const data = await readFileTree(root);
        if (Array.isArray(data)) setRootTop(prev => ({ ...prev, [root]: data }));
      } catch { /* 读取失败保持空层 */ }
      setRootLoading(null);
    }
  };

  const enterDir = (from: BrowsePos, seg: string) => {
    setMoveDir('fwd');
    setPos({ root: from.root, segs: [...from.segs, seg] });
  };
  const enterFromRoot = (root: string, seg: string) => {
    setMoveDir('fwd');
    setPos({ root, segs: [seg] });
  };
  const backToRoots = () => { setMoveDir('back'); setPos(null); };

  // 浏览视图内容：位置变化时按需读取该目录（单层）
  useEffect(() => {
    if (!pos) return;
    let alive = true;
    setLoading(true);
    readFileTree(joinAbs(pos.root, pos.segs))
      .then(data => { if (alive && Array.isArray(data)) setItems(data); })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [pos, readFileTree]);

  const renderRoots = () => (
    <div key="roots" className={`file-browser ${moveDir}`}>
      {roots.length === 0 ? (
        <div className="panel-empty">未挂载工作区（可在输入框旁的文件夹菜单添加）</div>
      ) : (
        <div className="workspace-list">
          {roots.map(r => {
            const open = expandedRoot === r.path;
            const top = rootTop[r.path];
            return (
              <div key={r.path} className="ws-item">
                <div className={`ws-head${open ? ' open' : ''}`} onClick={() => toggleRoot(r.path)} title={r.path}>
                  <span className={`tree-toggle${open ? ' expanded' : ''}`}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                  </span>
                  <span className="tree-folder-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                  </span>
                  <span className="ws-name">{r.name}</span>
                  {r.active && <span className="ws-active">当前</span>}
                  {rootLoading === r.path && <span className="ws-loading">加载中…</span>}
                </div>
                {/* 0fr→1fr 网格行过渡：纯 CSS 手风琴展开/收起动画 */}
                <div className={`ws-children${open ? ' open' : ''}`}>
                  <div className="ws-children-inner">
                    {open && (top === undefined ? <div className="file-tree-loading">加载中…</div>
                      : top.length === 0 ? <div className="panel-empty">空目录</div>
                      : top.map(node => node.type === 'folder' ? (
                          <div key={node.path} className="tree-item folder ws-child" onClick={() => enterFromRoot(r.path, node.name)} draggable onDragStart={e => handleNodeDragStart(e, node)} title={node.absPath || node.path}>
                            <span className="tree-folder-icon">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                            </span>
                            <span className="tree-name">{node.name}</span>
                            <span className="browser-enter-icon">›</span>
                          </div>
                        ) : (
                          <div key={node.path} className="tree-item file" draggable onDragStart={e => handleNodeDragStart(e, node)} title={node.absPath || node.path}>
                            {tagClassMap[node.ext || ''] ? <span className={`tree-tag ${tagClassMap[node.ext || '']}`}>{(tagLabelMap[node.ext || ''] || node.ext || '').toUpperCase()}</span>
                              : <span className="tree-icon">≡</span>}
                            <span className="tree-name">{node.name}</span>
                          </div>
                        )
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderBrowser = () => {
    if (!pos) return null;
    const rootName = pathBase(pos.root);
    const viewKey = `${pos.root}|${pos.segs.join('/')}`;
    return (
      <div key={viewKey} className={`file-browser ${moveDir}`}>
        <div className="browser-crumbs">
          <button className="browser-back" onClick={backToRoots} title="返回工作区列表">←</button>
          <span className="crumb root" onClick={() => { setMoveDir('back'); setPos({ root: pos.root, segs: [] }); }} title={pos.root}>{rootName}</span>
          {pos.segs.map((seg, i) => (
            <Fragment key={i}>
              <span className="crumb-sep">/</span>
              <span className="crumb" onClick={() => { setMoveDir(i < pos.segs.length - 1 ? 'back' : 'fwd'); setPos({ root: pos.root, segs: pos.segs.slice(0, i + 1) }); }}>{seg}</span>
            </Fragment>
          ))}
        </div>
        {loading ? <div className="file-tree-loading">加载中…</div>
          : items.length === 0 ? <div className="panel-empty">空目录</div>
          : <div className="browser-list">
              {items.map(node => node.type === 'folder' ? (
                <div key={node.path} className="tree-item folder browser-folder" onClick={() => enterDir(pos, node.name)} draggable onDragStart={e => handleNodeDragStart(e, node)} title={node.absPath || node.path}>
                  <span className="tree-folder-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                  </span>
                  <span className="tree-name">{node.name}</span>
                  <span className="browser-enter-icon">›</span>
                </div>
              ) : (
                <div key={node.path} className="tree-item file" draggable onDragStart={e => handleNodeDragStart(e, node)} title={node.absPath || node.path}>
                  {tagClassMap[node.ext || ''] ? <span className={`tree-tag ${tagClassMap[node.ext || '']}`}>{(tagLabelMap[node.ext || ''] || node.ext || '').toUpperCase()}</span>
                    : <span className="tree-icon">≡</span>}
                  <span className="tree-name">{node.name}</span>
                </div>
              ))}
            </div>}
      </div>
    );
  };

  return pos ? renderBrowser() : renderRoots();
}

const statusClassMap: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed' };

function GitChangesContent({ changes }: { changes: GitChange[] }) {
  if (changes.length === 0) return <div className="panel-empty">工作区干净，无变更</div>;
  return <div className="changes-list">
    {changes.map((ch, i) => (
      <div key={i} className={`change-item ${statusClassMap[ch.status] || 'untracked'}`} title={ch.file}>
        <span className="change-status">{ch.status}</span>
        <span className="change-file">{ch.file}</span>
      </div>
    ))}
  </div>;
}

/* ═══════════════════════════════════════════════════════════
   设备 Tab：信任设备列表（在线状态 + 撤销信任）
   ═══════════════════════════════════════════════════════════ */

function DevicesContent() {
  const api = useElectronAPI();
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await api.getRemoteDevices();
      if (Array.isArray(list)) setDevices(list);
    } catch { /* 保留旧列表 */ }
  }, [api]);

  // 首次挂载拉取 + 订阅 remote:devices 实时刷新（trust-updated / trust-list / trust-revoked 都会广播）
  useEffect(() => {
    load();
    const unsub = api.onRemoteDevices((data) => {
      if (Array.isArray(data?.devices)) setDevices(data.devices);
    });
    return () => unsub();
  }, [api, load]);

  const revoke = async (remoteId: string, label: string) => {
    if (!window.confirm(`确定撤销对「${label || remoteId}」的信任？\n撤销后该设备需重新配对才能连接。`)) return;
    try {
      await api.revokeRemoteDevice(remoteId);
      // 本地删除由 bridge 广播 remote:devices 驱动；这里再拉一次做兜底
      load();
    } catch { /* 撤销失败保留列表 */ }
  };

  if (devices.length === 0) {
    return <div className="panel-empty">暂无信任设备，手机端配对成功后自动出现</div>;
  }

  return (
    <div className="devices-list">
      {devices.map(d => (
        <div key={d.remoteId} className="device-item" title={d.remoteId}>
          <span className={`device-dot ${d.online ? 'online' : 'offline'}`} title={d.online ? '在线' : '离线'} />
          <div className="device-body">
            <div className="device-name">{d.label || d.remoteId}</div>
            <div className="device-meta">
              <span className={d.online ? 'device-status online' : 'device-status'}>{d.online ? '在线' : '离线'}</span>
              {d.trustedAt ? <span> · {formatTrustedAt(d.trustedAt)} 信任</span> : null}
            </div>
          </div>
          <button className="device-revoke-btn" onClick={() => revoke(d.remoteId, d.label || d.remoteId)} title="撤销信任">撤销</button>
        </div>
      ))}
    </div>
  );
}

/** 信任时间展示：ISO 字符串 → 本地日期（解析失败回退原文） */
function formatTrustedAt(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/* ═══════════════════════════════════════════════════════════
   协作 Tab：会话列表 + 身份卡 + 子 Agent + 协作动态
   ═══════════════════════════════════════════════════════════ */

const subagentModeLabel: Record<string, string> = { clone: '克隆', mission: '任务', listen: '监听', instructor: '指导' };
const subagentStatusLabel: Record<string, string> = { idle: '空闲', running: '运行中', done: '完成', error: '错误' };

function CollabContent({ runtimeData }: { runtimeData: SidebarRuntimeData | null }) {
  const api = useElectronAPI();
  const [log, setLog] = useState<CollabLogEntry[]>([]);
  // 协作聊天：当前选中的好友（子模型/worker），null = 通讯录视图
  const [chatPeer, setChatPeer] = useState<string | null>(null);
  const [chatType, setChatType] = useState<'subagent' | 'worker' | null>(null);

  // 通讯录好友：子模型 + worker（thread 中出现的 peer，去重）
  const friends = (() => {
    const map = new Map<string, { name: string; type: 'subagent' | 'worker'; status?: string; lastMsg?: string }>();
    (runtimeData?.subAgents ?? []).forEach(a => map.set(a.name, { name: a.name, type: 'subagent', status: a.status }));
    (runtimeData?.threads ?? []).forEach(t => {
      const existing = map.get(t.peerName);
      if (existing) {
        existing.status = t.peerType === 'subagent' ? existing.status : undefined;
      } else {
        map.set(t.peerName, { name: t.peerName, type: t.peerType });
      }
      const last = t.messages[t.messages.length - 1];
      if (last) {
        const item = map.get(t.peerName)!;
        item.lastMsg = `${last.role === 'manager' ? '我' : '对方'}: ${last.content.slice(0, 40)}`;
      }
    });
    return Array.from(map.values());
  })();

  // 选中的 thread（供聊天视图）
  const chatThread = chatPeer ? (runtimeData?.threads ?? []).find(t => t.peerName === chatPeer) : undefined;

  const loadLog = useCallback(async () => {
    try {
      const data = await api.getCollabLog();
      if (Array.isArray(data)) setLog(data);
    } catch { /* 保留旧列表 */ }
  }, [api]);

  useEffect(() => {
    loadLog();
    // 定时刷新协作动态（主进程事件推送，开销小）
    const t = setInterval(() => { loadLog(); api.sendCommand('sidebar:data'); }, 10000);
    return () => clearInterval(t);
  }, [loadLog]);

  // 协作事件推送：有新的跨会话通信时刷新动态
  useEffect(() => {
    const unsubLog = api.onCollabEvent((ev) => {
      if (ev.type === 'log') loadLog();
    });
    return () => { unsubLog(); };
  }, [api, loadLog]);
  if (chatPeer && chatType) {
    return (
      <ChatView
        peer={chatPeer}
        peerType={chatType}
        thread={chatThread}
        streams={runtimeData?.subagentStreams}
        api={api}
        onBack={() => { setChatPeer(null); setChatType(null); }}
      />
    );
  }

  return (
    <div className="collab-content">

      <div className="collab-section">
        <div className="collab-section-title">
          通讯录（{runtimeData?.mode?.includes('manager') ? '下属' : runtimeData?.mode?.includes('worker') ? '帮手' : '协作对象'}）
          <span className="collab-count">{friends.length}</span>
        </div>
        {friends.length === 0
          ? <div className="panel-empty">暂无下属（可 spawn 子模型或跨会话派活）</div>
          : <div className="collab-subagent-list">
              {friends.map(f => (
                <div key={f.name} className="collab-subagent friend"
                  onClick={() => { setChatPeer(f.name); setChatType(f.type); }}
                  title={f.type === 'subagent' ? '子模型：点击进入聊天' : '打工人会话：点击进入聊天'}>
                  <span className={`collab-friend-avatar ${f.type}`}>
                    {f.type === 'subagent' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="4" y="8" width="16" height="12" rx="2"/>
                        <path d="M12 8V4"/><circle cx="12" cy="2.5" r="1.5" fill="currentColor" stroke="none"/>
                        <circle cx="9" cy="13" r="1.5" fill="currentColor" stroke="none"/>
                        <circle cx="15" cy="13" r="1.5" fill="currentColor" stroke="none"/>
                        <path d="M9 17c1 .8 5 .8 6 0" strokeLinecap="round"/>
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                      </svg>
                    )}
                  </span>
                  <div className="collab-friend-body">
                    <div className="collab-subagent-name">{f.name}</div>
                    <div className="collab-friend-last">{f.lastMsg || (f.type === 'subagent' ? (subagentStatusLabel[f.status || ''] || f.status || '空闲') : '打工人')}</div>
                  </div>
                </div>
              ))}
            </div>}
      </div>

      <div className="collab-section">
        <div className="collab-section-title">协作动态 <span className="collab-count">{log.length}</span></div>
        {log.length === 0 ? <div className="panel-empty">暂无跨会话通信记录</div> : (
          <div className="collab-log">
            {log.map((entry, i) => (
              <div key={`${entry.ts}-${i}`} className={`collab-log-item ${entry.direction === 'reply' ? 'reply' : 'out'}`}>
                <div className="collab-log-head">
                  <span className="collab-log-arrow">
                    {entry.direction === 'out' ? (
                      <>
                        <span className="collab-log-dir-name">{entry.fromName || entry.from}</span>
                        <svg className="collab-log-dir-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="5" y1="12" x2="19" y2="12" />
                          <polyline points="12 5 19 12 12 19" />
                        </svg>
                        <span className="collab-log-dir-name">{entry.toName || entry.to}</span>
                      </>
                    ) : (
                      <>
                        <span className="collab-log-dir-name">{entry.fromName || entry.from}</span>
                        <svg className="collab-log-dir-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="1 4 1 10 7 10" />
                          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                        </svg>
                        <span className="collab-log-dir-name">{entry.toName || entry.to}</span>
                      </>
                    )}
                  </span>
                  <span className="collab-log-time">{entry.time}</span>
                </div>
                <div className="collab-log-content">{entry.content.slice(0, 120)}{entry.content.length > 120 ? '…' : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}











/* ═══════════════════════════════════════════════════════════
   协作聊天视图：与某个下属（子模型/worker）的独立对话
   ═══════════════════════════════════════════════════════════ */

function ChatView({ peer, peerType, thread, streams, api, onBack }: {
  peer: string;
  peerType: 'subagent' | 'worker';
  thread?: ChatThreadData;
  /** 子 Agent 消息流（便条窗体数据源；worker 无流，按钮隐藏） */
  streams?: Record<string, SubagentStreamMsg[]>;
  api: ReturnType<typeof useElectronAPI>;
  onBack: () => void;
}) {
  const [text, setText] = useState('');
  // 便条窗体开关：把子 Agent 消息流渲染到主消息区上方的叠加窗体
  const [noteOpen, setNoteOpen] = useState(false);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    // 发给 agent 进程：chat:send <peer>|<content>（子模型后台执行 / worker 走 collab_send）
    api.sendCommand(`chat:send ${peer}|${t}`);
    setText('');
    // 主动拉取最新 threads（含本地乐观消息 + 子模型提交）
    api.sendCommand('sidebar:data');
  };
  const msgs = thread?.messages ?? [];
  const hasStream = peerType === 'subagent' && Array.isArray(streams?.[peer]);
  return (
    <div className="chat-view">
      <div className="chat-view-header">
        <button className="chat-back" onClick={onBack} title="返回通讯录">←</button>
        <span className="chat-peer-name">{peer}</span>
        <span className={`chat-peer-type ${peerType}`}>{peerType === 'subagent' ? '子模型' : '打工人'}</span>
        {hasStream && (
          <button className="chat-note-btn" onClick={() => setNoteOpen(true)} title="便条：以消息颗粒度追踪该子 Agent 的工作进度">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          </button>
        )}
      </div>
      <div className="chat-messages">
        {msgs.length === 0 && <div className="panel-empty">还没有对话，发条消息开始协作</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role === 'manager' ? 'manager' : 'peer'}`}>
            <div className="chat-bubble-time">{new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false })}</div>
            <div className="chat-bubble-text">{m.content}</div>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          className="chat-input"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={peerType === 'subagent' ? `给子模型 ${peer} 派活…` : `给打工人 ${peer} 发消息…`}
        />
        <button className="chat-send-btn" onClick={send} disabled={!text.trim()}>发送</button>
      </div>
      {noteOpen && hasStream && (
        <SubagentNotePanel
          peer={peer}
          stream={streams?.[peer] ?? []}
          onClose={() => setNoteOpen(false)}
        />
      )}
    </div>
  );
}



































