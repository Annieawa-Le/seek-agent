import { useState, useEffect, useCallback } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { SessionInfo, SidebarStaticData, SidebarRuntimeData } from '@/types/index.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 当前活动会话 ID */
  currentSessionId: string;
  /** 当前会话的运行时数据（hooks/子agent/MCP 状态） */
  runtimeData: SidebarRuntimeData | null;
  onNewSession: () => void;
  /** 切换到指定会话（已保存会话传 name） */
  onSwitchSession: (sessionId: string, name?: string) => void;
}

const customItems = [
  { key: 'agents', label: 'Agents', icon: 'M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4zM2 22v-2a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6v2' },
  { key: 'skills', label: 'Skills', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { key: 'instructions', label: 'Instructions', icon: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z' },
  { key: 'hooks', label: 'Hooks', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
  { key: 'mcp', label: 'MCP Servers', icon: 'M8 3v14M12 3v14M4 21h16' },
  { key: 'plugins', label: 'Plugins', icon: 'M20 12H4M12 4v16' },
];

const modeLabelMap: Record<string, string> = {
  clone: '克隆', mission: '任务', listen: '监听', instructor: '指导',
};
const statusLabelMap: Record<string, string> = {
  idle: '空闲', running: '运行中', done: '完成', error: '错误',
};

export function LeftSidebar({ open, currentSessionId, runtimeData, onNewSession, onSwitchSession }: Props) {
  const api = useElectronAPI();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [staticData, setStaticData] = useState<SidebarStaticData | null>(null);
  /** 正在运行（processing）的会话集合 */
  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());
  /** 主进程存活的会话进程 */
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const [expandedCustom, setExpandedCustom] = useState<string | null>(null);
  const [customCollapsed, setCustomCollapsed] = useState(false);
  /** 已展开的 Instruction 内容（key = kind:file） */
  const [instructionContent, setInstructionContent] = useState<Record<string, string>>({});
  const [loadingInstruction, setLoadingInstruction] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    const data = await api.listSessions();
    if (Array.isArray(data)) setSessions(data);
  }, [api]);

  const loadStatic = useCallback(async () => {
    const data = await api.getSidebarStatic();
    if (data) setStaticData(data);
  }, [api]);

  const loadActive = useCallback(async () => {
    const data = await api.listActiveSessions();
    if (Array.isArray(data)) setActiveSessionIds(data.map(d => d.sessionId));
  }, [api]);

  useEffect(() => {
    loadSessions();
    loadStatic();
    loadActive();
    const t = setInterval(loadActive, 5000);
    return () => clearInterval(t);
  }, [loadSessions, loadStatic, loadActive]);

  // 监听消息流：更新各会话的运行状态（后台会话也在继续跑）
  useEffect(() => {
    const unsub = api.onMessage((msg) => {
      if (!msg.sessionId) return;
      if (msg.type === 'state') {
        setRunningSessions(prev => {
          const next = new Set(prev);
          if (msg.processing) next.add(msg.sessionId as string);
          else next.delete(msg.sessionId as string);
          return next;
        });
      } else if (msg.type === 'tool-call' || msg.type === 'thinking' || msg.type === 'thinking-bubble') {
        if (msg.type === 'thinking' && !msg.active) {
          setRunningSessions(prev => {
            const next = new Set(prev);
            next.delete(msg.sessionId as string);
            return next;
          });
        } else {
          setRunningSessions(prev => new Set(prev).add(msg.sessionId as string));
        }
      }
    });
    return unsub;
  }, [api]);

  const handleNewSession = () => {
    onNewSession();
    // 稍后刷新（新进程拉起需要时间）
    setTimeout(() => { loadSessions(); loadActive(); }, 800);
  };

  const handleSwitchSession = (s: SessionInfo) => {
    onSwitchSession(s.name, s.name);
  };

  /** 展开/收起 Instruction 文件内容 */
  const toggleInstruction = async (kind: string, file: string) => {
    const key = `${kind}:${file}`;
    if (instructionContent[key]) {
      setInstructionContent(prev => {
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
      return;
    }
    setLoadingInstruction(key);
    const res = await api.readInstruction(kind, file);
    if (res.content) {
      setInstructionContent(prev => ({ ...prev, [key]: res.content as string }));
    }
    setLoadingInstruction(null);
  };

  // ── Customizations 真实数据组装 ──
  const enabledSkills = (staticData?.skills || []).filter(s => s.enabled);
  const agents = [
    { name: 'seek-agent (主)', desc: '默认主 Agent 循环' },
    ...(staticData?.addonAgents || []).map(a => ({ name: a.name, desc: '领域 Agent（addon）' })),
    ...(runtimeData?.subAgents || []).map(a => ({
      name: a.name,
      desc: `子 Agent · ${modeLabelMap[a.mode || ''] || a.mode} · ${statusLabelMap[a.status || ''] || a.status}`,
    })),
  ];
  const mcpItems = (staticData?.mcpConfig || []).map(cfg => {
    const st = (runtimeData?.mcp || []).find(m => m.name === cfg.name);
    return { name: cfg.name, desc: st ? (st.initialized ? `已连接 · ${cfg.command}` : `未连接 · ${cfg.command}`) : `未连接 · ${cfg.command}` };
  });
  const pluginItems = (staticData?.skills || []).map(s => ({
    name: s.name,
    desc: s.enabled ? '已启用' : '未启用',
  }));

  const subItemsMap: Record<string, Array<{ name: string; desc?: string }>> = {
    agents,
    skills: enabledSkills.map(s => ({ name: s.name, desc: s.description })),
    instructions: (staticData?.instructions || []).map(i => ({ name: i.name, desc: i.kind })),
    hooks: (runtimeData?.hooks || []).map(h => ({ name: h.name, desc: h.description })),
    mcp: mcpItems,
    plugins: pluginItems,
  };

  const badgeCount: Record<string, number> = {
    agents: agents.length,
    skills: enabledSkills.length,
    instructions: staticData?.instructions.length || 0,
    hooks: runtimeData?.hooks.length || 0,
    mcp: staticData?.mcpConfig.length || 0,
    plugins: staticData?.skills.length || 0,
  };

  return (
    <aside id="left-sidebar" className={open ? 'open' : ''}>
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
        {sessions.length === 0 && activeSessionIds.length === 0 ? <div className="session-empty">暂无会话</div> : <>
          {sessions.map(s => {
            const timeStr = s.timestamp ? new Date(s.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const isActive = currentSessionId === s.name;
            const isRunning = runningSessions.has(s.name) || (activeSessionIds.includes(s.name) && isActive);
            return (
              <div key={s.name} className={`session-item${isActive ? ' active' : ''}`} onClick={() => handleSwitchSession(s)} title={`切换到会话 ${s.name}`}>
                <div className="session-name">
                  {s.name}
                  {isRunning && <span className="session-dot" title="该会话正在运行">●</span>}
                </div>
                <div className="session-meta">{s.messageCount} msgs{timeStr ? ` · ${timeStr}` : ''}</div>
                {s.preview && <div className="session-preview">{s.preview.slice(0, 60)}</div>}
              </div>
            );
          })}
          {/* 运行中但尚未落盘的新会话 */}
          {activeSessionIds.filter(id => !sessions.some(s => s.name === id)).map(id => (
            <div key={id} className={`session-item${currentSessionId === id ? ' active' : ''}`} onClick={() => onSwitchSession(id)} title={`切换到运行中会话 ${id}`}>
              <div className="session-name">
                {id}
                <span className="session-dot running" title="该会话正在运行">●</span>
              </div>
              <div className="session-meta">运行中（未保存）</div>
            </div>
          ))}
        </>}
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
                {badgeCount[item.key] > 0 && <span className="custom-badge">{badgeCount[item.key]}</span>}
                <span className={`custom-expand${expandedCustom === item.key ? ' expanded' : ''}`}>{expandedCustom === item.key ? '▼' : '▶'}</span>
              </li>
            ))}
          </ul>
        )}

        {expandedCustom && !customCollapsed && (
          <div className="custom-subitems">
            {expandedCustom === 'instructions'
              ? (subItemsMap[expandedCustom] || []).map(item => {
                  const inst = (staticData?.instructions || []).find(i => i.name === item.name && i.kind === item.desc);
                  const key = inst ? `${inst.kind}:${inst.file}` : item.name;
                  const content = instructionContent[key];
                  const loading = loadingInstruction === key;
                  return (
                    <div key={key}>
                      <div className="custom-subitem" onClick={() => inst && toggleInstruction(inst.kind, inst.file)} title={inst ? '点击查看内容' : item.desc}>
                        <span className="custom-subicon">{inst ? (content ? '▾' : '▸') : '·'}</span>
                        <span className="custom-subname">{item.name}</span>
                        <span className="custom-submeta">{item.desc}</span>
                      </div>
                      {content && (
                        <div className="custom-instruction-preview">
                          {loading ? '加载中…' : content.slice(0, 300) + (content.length > 300 ? '…' : '')}
                        </div>
                      )}
                    </div>
                  );
                })
              : (subItemsMap[expandedCustom] || []).map(item => (
                  <div key={item.name} className="custom-subitem" title={item.desc || ''}>
                    <span className="custom-subicon">·</span>
                    <span className="custom-subname">{item.name}</span>
                    {item.desc && <span className="custom-submeta">{item.desc.slice(0, 40)}</span>}
                  </div>
                ))}
          </div>
        )}
      </div>
    </aside>
  );
}

