import { useState, useEffect, useCallback } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { ChatThreadData, CollabLogEntry, CollabSession, FileTreeNode, GitChange, IdentityCard, SidebarRuntimeData } from '@/types/index.ts';

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
  icon.style.cssText = 'font-size: 15px; line-height: 1; flex-shrink: 0;';
  icon.textContent = node.type === 'folder' ? '📁' : '📄';
  const label = document.createElement('span');
  label.style.cssText = 'overflow: hidden; text-overflow: ellipsis;';
  label.textContent = node.name;
  img.appendChild(icon);
  img.appendChild(label);
  document.body.appendChild(img);
  dragImageEl = img;
  e.dataTransfer.setDragImage(img, 10, 10);
  window.addEventListener('dragend', cleanupDragImage, { once: true });
}

type PanelTab = 'files' | 'changes' | 'collab';

export function RightPanel({ runtimeData }: { runtimeData: SidebarRuntimeData | null }) {
  const { readFileTree, readGitStatus } = useElectronAPI();
  const [currentTab, setCurrentTab] = useState<PanelTab>('files');
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [gitChanges, setGitChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(false);

  const loadFileTree = useCallback(async () => {
    setLoading(true);
    const data = await readFileTree('');
    if (Array.isArray(data)) setFileTree(data);
    setLoading(false);
  }, [readFileTree]);

  const loadGitChanges = useCallback(async () => {
    setLoading(true);
    const data = await readGitStatus();
    if (Array.isArray(data)) setGitChanges(data);
    setLoading(false);
  }, [readGitStatus]);

  useEffect(() => {
    if (currentTab === 'files') loadFileTree();
    else if (currentTab === 'changes') loadGitChanges();
  }, [currentTab, loadFileTree, loadGitChanges]);

  return (
    <aside id="info-panel">
      <div className="panel-tabs">
        <span className={`panel-tab${currentTab === 'files' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('files')}>文件</span>
        <span className={`panel-tab${currentTab === 'changes' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('changes')}>改动</span>
        <span className={`panel-tab${currentTab === 'collab' ? ' active' : ' inactive'}`} onClick={() => setCurrentTab('collab')}>协作</span>
        <div className="panel-tab-actions">
          <button className="panel-tab-btn" title="搜索"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
          <button className="panel-tab-btn" title="面板布局"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
        </div>
      </div>
      <div id="panel-content">
        {currentTab === 'files' && (loading ? <div className="file-tree-loading">加载中…</div> : <FileTreeContent nodes={fileTree} />)}
        {currentTab === 'changes' && (loading ? <div className="file-tree-loading">加载中…</div> : <GitChangesContent changes={gitChanges} />)}
        {currentTab === 'collab' && <CollabContent runtimeData={runtimeData} />}
      </div>
    </aside>
  );
}

function FileTreeContent({ nodes }: { nodes: FileTreeNode[] }) {
  if (nodes.length === 0) return <div className="panel-empty">项目为空</div>;
  return <div className="file-tree"><TreeNodes nodes={nodes} /></div>;
}

function TreeNodes({ nodes }: { nodes: FileTreeNode[] }) {
  return <>
    {nodes.map(node =>
      node.type === 'folder' ? <FolderNode key={node.path} node={node} />
        : (
          <div key={node.path} className="tree-item file" data-path={node.path} draggable onDragStart={e => handleNodeDragStart(e, node)} title={node.path}>
            {tagClassMap[node.ext || ''] ? <span className={`tree-tag ${tagClassMap[node.ext || '']}`}>{(tagLabelMap[node.ext || ''] || node.ext || '').toUpperCase()}</span>
              : <span className="tree-icon">≡</span>}
            <span className="tree-name">{node.name}</span>
          </div>
        )
    )}
  </>;
}

/** 文件夹节点：懒加载子层（首次展开时按需请求该目录内容，避免同步遍历整个工作区） */
function FolderNode({ node }: { node: FileTreeNode }) {
  const { readFileTree } = useElectronAPI();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileTreeNode[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const willExpand = !expanded;
    if (willExpand && children === null) {
      setLoading(true);
      try {
        const data = await readFileTree(node.path);
        if (Array.isArray(data)) setChildren(data);
      } catch { /* 读取失败保持折叠 */ }
      setLoading(false);
    }
    setExpanded(willExpand);
  };

  return <>
    <div className="tree-item folder" onClick={toggle} draggable onDragStart={e => handleNodeDragStart(e, node)} title={node.path}>
      <span className="tree-toggle">{expanded ? '▼' : '▶'}</span>
      <span className="tree-folder-icon">📁</span>
      <span className="tree-name">{node.name}</span>
    </div>
    {expanded && children && <div className="tree-children"><TreeNodes nodes={children} /></div>}
    {expanded && loading && <div className="file-tree-loading">加载中…</div>}
  </>;
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
   协作 Tab：会话列表 + 身份卡 + 子 Agent + 协作动态
   ═══════════════════════════════════════════════════════════ */

const subagentModeLabel: Record<string, string> = { clone: '克隆', mission: '任务', listen: '监听', instructor: '指导' };
const subagentStatusLabel: Record<string, string> = { idle: '空闲', running: '运行中', done: '完成', error: '错误' };

function CollabContent({ runtimeData }: { runtimeData: SidebarRuntimeData | null }) {
  const api = useElectronAPI();
  const [sessions, setSessions] = useState<CollabSession[]>([]);
  const [log, setLog] = useState<CollabLogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
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

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.getCollabSessions();
      if (Array.isArray(data)) setSessions(data);
    } catch { /* 保留旧列表 */ }
  }, [api]);

  const loadLog = useCallback(async () => {
    try {
      const data = await api.getCollabLog();
      if (Array.isArray(data)) setLog(data);
    } catch { /* 保留旧列表 */ }
  }, [api]);

  useEffect(() => {
    loadSessions();
    loadLog();
    // 定时刷新会话与协作动态（主进程签名缓存 + 事件推送，开销小）
    const t = setInterval(() => { loadSessions(); loadLog(); api.sendCommand('sidebar:data'); }, 10000);
    return () => clearInterval(t);
  }, [loadSessions, loadLog]);

  // 协作事件推送：有新的跨会话通信时刷新动态
  useEffect(() => {
    const unsubLog = api.onCollabEvent((ev) => {
      if (ev.type === 'log') loadLog();
    });
    // 身份卡生成完成：刷新会话列表（preview/identity 变化）
    const unsubCard = api.onIdentityCard(() => loadSessions());
    return () => { unsubLog(); unsubCard(); };
  }, [api, loadLog, loadSessions]);

  const selected = sessions.find(s => s.sessionId === selectedId) || null;

  const handleGenerate = async () => {
    if (!selected || !selected.active || generating) return;
    setGenerating(true);
    try {
      await api.generateIdentityCard(selected.sessionId);
      // 身份卡写入由 onIdentityCard 事件驱动刷新，此处轮询兜底
      setTimeout(loadSessions, 3000);
    } finally {
      setGenerating(false);
    }
  };

  // ── 聊天视图：选中好友时展示与该下属的独立对话 ──
  if (chatPeer && chatType) {
    return (
      <ChatView
        peer={chatPeer}
        peerType={chatType}
        thread={chatThread}
        api={api}
        onBack={() => { setChatPeer(null); setChatType(null); }}
      />
    );
  }

  return (
    <div className="collab-content">
      <div className="collab-section">
        <div className="collab-section-title">会话 <span className="collab-count">{sessions.length}</span></div>
        {sessions.length === 0 ? <div className="panel-empty">暂无会话</div> : (
          <div className="collab-session-list">
            {sessions.map(s => (
              <div key={s.sessionId} className={`collab-session${selectedId === s.sessionId ? ' selected' : ''}`}
                onClick={() => setSelectedId(s.sessionId)} title={s.sessionId}>
                <div className="collab-session-head">
                  <span className="collab-session-name">{s.name}</span>
                  {s.active && <span className="collab-live-dot" title="活跃会话">●</span>}
                  {s.identity && <span className="collab-card-badge" title="有身份卡">卡</span>}
                </div>
                <div className="collab-session-meta">
                  {s.messageCount != null && `${s.messageCount} msgs`}
                  {s.mtime ? ` · ${s.mtime}` : ''}
                  {s.identity?.generatedAt ? ` · 更新于 ${s.identity.generatedAt.slice(0, 16).replace('T', ' ')}` : ''}
                </div>
                {s.preview && <div className="collab-session-preview">{s.preview.slice(0, 80)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="collab-section">
          <div className="collab-section-title">
            身份卡
            {selected.active && (
              <button className="collab-gen-btn" onClick={handleGenerate} disabled={generating} title="用轻量模型生成/更新身份卡">
                {generating ? '生成中…' : '生成/更新'}
              </button>
            )}
          </div>
          {selected.identity ? <IdentityCardView card={selected.identity} />
            : <div className="panel-empty">{selected.active ? '该会话暂无身份卡，点击"生成/更新"创建' : '该会话尚未生成身份卡（历史会话需先打开）'}</div>}
        </div>
      )}

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
                  <span className={`collab-friend-avatar ${f.type}`}>{f.type === 'subagent' ? '🤖' : '🧑‍🔧'}</span>
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
                    {entry.direction === 'out' ? `${entry.fromName || entry.from} → ${entry.toName || entry.to}` : `${entry.fromName || entry.from} ↺ ${entry.toName || entry.to}`}
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

function IdentityCardView({ card }: { card: IdentityCard }) {
  return (
    <div className="identity-card">
      {card.focus && <div className="identity-field"><span className="identity-label">焦点</span><div>{card.focus}</div></div>}
      {card.summary && <div className="identity-field"><span className="identity-label">摘要</span><div>{card.summary}</div></div>}
      {card.conclusions?.length ? (
        <div className="identity-field"><span className="identity-label">结论</span>
          <ul className="identity-list">{card.conclusions.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      ) : null}
      {card.relatedSkills?.length ? (
        <div className="identity-field"><span className="identity-label">相关技能</span>
          <div className="identity-tags">{card.relatedSkills.map((s, i) => <span key={i} className="identity-tag">{s}</span>)}</div>
        </div>
      ) : null}
    </div>
  );
}










/* ═══════════════════════════════════════════════════════════
   协作聊天视图：与某个下属（子模型/worker）的独立对话
   ═══════════════════════════════════════════════════════════ */

function ChatView({ peer, peerType, thread, api, onBack }: {
  peer: string;
  peerType: 'subagent' | 'worker';
  thread?: ChatThreadData;
  api: ReturnType<typeof useElectronAPI>;
  onBack: () => void;
}) {
  const [text, setText] = useState('');
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
  return (
    <div className="chat-view">
      <div className="chat-view-header">
        <button className="chat-back" onClick={onBack} title="返回通讯录">←</button>
        <span className="chat-peer-name">{peer}</span>
        <span className={`chat-peer-type ${peerType}`}>{peerType === 'subagent' ? '子模型' : '打工人'}</span>
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
    </div>
  );
}




