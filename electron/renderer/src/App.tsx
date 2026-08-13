import { useEffect, useCallback, useState, useRef } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { useRemoteConnection } from '@/components/RemoteConnectionContext.tsx';
import { useAgentStatus } from '@/hooks/useAgentStatus.ts';
import { useMessages } from '@/hooks/useMessages.ts';
import { Header } from '@/components/Header.tsx';
import { SettingsPanel } from '@/components/SettingsPanel.tsx';
import { LeftSidebar } from '@/components/LeftSidebar.tsx';
import { MessageList } from '@/components/MessageList.tsx';
import { ModePicker } from '@/components/ModePicker.tsx';
import { InputBar } from '@/components/InputBar.tsx';
import { RightPanel } from '@/components/RightPanel.tsx';
import { StatusBar } from '@/components/StatusBar.tsx';
import { RemoteStatusBar } from '@/components/RemoteStatusBar.tsx';
import type { AgentMessage, SessionInfo, SidebarRuntimeData } from '@/types/index.ts';
import type { TabItem } from '@/components/Tabs.tsx';

export function App() {
  // 当前活动会话（与主进程 currentSessionId 保持一致）
  const api = useElectronAPI();
  const apiReady = !!window.electronAPI;
  // 远程模式（Provider 存在）时不早退：未连接由 main-content 占位接管，侧边栏「连接远程」按钮保持可用
  const remoteConn = useRemoteConnection();
  const [currentSessionId, setCurrentSessionId] = useState('default');
  /** 会话是否已就绪（切换会话时防 ModePicker 闪现；replace-messages 到达后置 true） */
  const [sessionReady, setSessionReady] = useState(true);
  const currentSessionRef = useRef('default');
  useEffect(() => { currentSessionRef.current = currentSessionId; }, [currentSessionId]);
  /** 当前会话进程的真实胶囊状态（input-state 快照，发送时差量比对用） */
  const inputStateRef = useRef<{ kbEnabled: boolean; smartSearch: boolean; thinking: boolean } | null>(null);
  // 当前会话的运行时数据（hooks/子agent/MCP 状态，由 sidebar:data 消息更新）
  const [runtimeData, setRuntimeData] = useState<SidebarRuntimeData | null>(null);
  /** 标题栏标签页：本次会话期间打开过的会话（浏览器式多标签管理的基础） */
  const [tabs, setTabs] = useState<TabItem[]>([]);
  /** sessionId/文件名 → 会话显示名 映射（来自会话列表，用于同步标签页标题） */
  const [sessionNameMap, setSessionNameMap] = useState<Record<string, string>>({});


  const status = useAgentStatus(currentSessionId);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    // 默认浅色模式；若用户之前手动切换过，则记住其选择
    const saved = localStorage.getItem('seek-agent-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [kbEnabled, setKbEnabled] = useState(true);
  const [smartSearchEnabled, setSmartSearchEnabled] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 右侧栏开合：桌面默认开、手机（≤900px）默认关，由 Header 的 panel-toggle 按钮切换 */
  const [rightOpen, setRightOpen] = useState<boolean>(() => window.innerWidth > 900);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsList, setSkillsList] = useState<Array<{ name: string; description: string }>>([]);
  // 同步主题到 data-theme 属性
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('seek-agent-theme', next);
      return next;
    });
  }, []);
  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const onToggleKb = useCallback(() => {
    setKbEnabled(prev => {
      const next = !prev;
      api.sendCommand(next ? 'kb_enable' : 'kb_disable');
      return next;
    });
  }, [api]);
  const onToggleSmartSearch = useCallback((enabled: boolean) => {
    setSmartSearchEnabled(enabled);
    api.sendCommand(enabled ? 'smart_search_enable' : 'smart_search_disable');
  }, [api]);
  const onToggleThinking = useCallback((enabled: boolean) => {
    setThinkingEnabled(enabled);
    api.sendCommand(enabled ? 'thinking_enable' : 'thinking_disable');
  }, [api]);

  const {
    messages,
    panelState,
    appendMessage,
    appendToStreaming,
    addToolToAgent,
    updateToolResult,
    setToolCallCount,
    replaceMessages,
    loadEarlier,
    hasEarlier,
    endStreaming,
    clearMessages,
    removeLastAgent,
    startThinking,
    appendThinkingDelta,
    endThinking,
    beginNewRound,
  } = useMessages();

  const handleMessage = useCallback((msg: AgentMessage) => {
    // 会话隔离：只处理当前活动会话的消息（其他会话在后台继续运行）
    if (msg.sessionId && msg.sessionId !== currentSessionRef.current) return;

    switch (msg.type) {
      case 'clear-messages':
        // 会话切换/加载时，agent 进程通过 clear-messages 通知清空
        clearMessages();
        break;

      case 'replace-messages':
        // 加载/切换会话：agent 进程一次性发送完整重建列表，整体替换
        if (msg.messages) replaceMessages(msg.messages);
        setSessionReady(true);
        break;

      case 'sidebar-data':
        if (msg.data) setRuntimeData(msg.data);
        break;
      case 'input-state':
        // 会话进程真实胶囊状态快照：发送时据此做差量同步（UI 全局偏好 vs 进程实际）
        inputStateRef.current = {
          kbEnabled: msg.kbEnabled ?? false,
          smartSearch: msg.smartSearch ?? false,
          thinking: msg.thinking ?? false,
        };
        break;

      case 'message':
        switch (msg.role) {
          case 'user':
            // 用户消息是服务端 echo，本地已提前渲染，跳过
            break;
          case 'agent':
            appendMessage({ role: 'agent', content: msg.content || '', createdAt: Date.now() });
            break;
          case 'tool':
            if (msg.toolMeta) {
              addToolToAgent(msg);
            } else {
              updateToolResult(msg);
            }
            break;
          case 'system':
            appendMessage({ role: 'system', content: msg.content || '', createdAt: Date.now() });
            break;
          case 'divider':
            appendMessage({ role: 'divider', content: '' });
            break;
          case 'blank':
            appendMessage({ role: 'blank', content: '' });
            break;
        }
        break;

      case 'thinking-bubble':
        // 思考模式：开始/结束思考过程气泡
        if (msg.active) {
          startThinking();
        } else {
          endThinking();
        }
        break;

      case 'thinking-delta':
        if (msg.content) {
          appendThinkingDelta(msg.content);
        }
        break;

      case 'subagent':
        appendMessage({
          role: 'subagent',
          content: msg.content || '',
          subagentName: msg.name || '子模型',
          createdAt: Date.now(),
        });
        break;

      case 'instructor':
        // instructor 建议：用户样式 + 鲸鱼标志气泡
        appendMessage({
          role: 'instructor',
          content: msg.content || '',
          subagentName: msg.name || '教练',
          createdAt: Date.now(),
        });
        break;

      case 'append':
        // 流式追加：追加到当前流式气泡，不创建新气泡
        if (msg.content) {
          appendToStreaming(msg.content);
        }
        break;

      case 'state':
        if (!msg.processing) {
          endStreaming();
        } else {
          // 新轮次开始，仅清理上一轮未正常结束（卡在流式状态）的残留气泡
          removeLastAgent(true);
        }
        break;

      case 'tool-call':
        setToolCallCount(msg.count ?? 0);
        break;
    }
  }, [appendMessage, appendToStreaming, addToolToAgent, updateToolResult,
      setToolCallCount, endStreaming, removeLastAgent, startThinking,
      appendThinkingDelta, endThinking, clearMessages, replaceMessages]);

  useEffect(() => {
    const unsub = api.onMessage(handleMessage);
    return () => unsub();
  }, [api, handleMessage]);

  // 后台拉起 Agent 失败兜底：目标会话进程未就绪/超时时提示并解除加载态
  useEffect(() => {
    const unsub = api.onSessionError(({ sessionId, error }) => {
      if (sessionId !== currentSessionRef.current) return;
      appendMessage({ role: 'system', content: `【错误】${error}（${sessionId}）`, createdAt: Date.now() });
      setSessionReady(true);
    });
    return () => unsub();
  }, [api, appendMessage]);


  // 挂载后同步主进程当前会话，并请求一次运行时数据
  useEffect(() => {
    api.getCurrentSession().then(({ sessionId }) => {
      if (sessionId) {
        currentSessionRef.current = sessionId;
        setCurrentSessionId(sessionId);
        ensureTab(sessionId);
      }
      api.sendCommand('sidebar:data');
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 欢迎消息
  useEffect(() => {
    appendMessage({ role: 'banner', content: '', createdAt: Date.now() });
    appendMessage({ role: 'system', content: 'Seek Agent 已启动。输入消息开始对话。', createdAt: Date.now() });
    appendMessage({ role: 'blank', content: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载可选技能列表
  useEffect(() => {
    api.getSkillsList().then(list => {
      if (list.length > 0) setSkillsList(list);
    });
  }, [api]);

  const handleSend = useCallback((text: string) => {
    // 胶囊状态按会话独立存于各 agent 进程；UI 开关是全局偏好，发送前做差量同步
    const actual = inputStateRef.current;
    if (actual) {
      if (kbEnabled !== actual.kbEnabled) api.sendCommand(kbEnabled ? 'kb_enable' : 'kb_disable');
      if (smartSearchEnabled !== actual.smartSearch) api.sendCommand(smartSearchEnabled ? 'smart_search_enable' : 'smart_search_disable');
      if (thinkingEnabled !== actual.thinking) api.sendCommand(thinkingEnabled ? 'thinking_enable' : 'thinking_disable');
    }
    beginNewRound();
    appendMessage({ role: 'user', content: text, createdAt: Date.now() });
    api.sendInput(text);
  }, [api, appendMessage, beginNewRound, kbEnabled, smartSearchEnabled, thinkingEnabled]);

  const handleAbort = useCallback(() => {
    api.abort();
    endStreaming();
  }, [api, endStreaming]);

  /** 把会话登记到标签栏：新会话追加到末尾；已存在则保持原位（仅标题变化时更新），不重排 */
  const ensureTab = useCallback((id: string, title?: string) => {
    setTabs(prev => {
      const t = prev.find(x => x.id === id);
      if (t) {
        return t.title === (title || id) ? prev : prev.map(x => x.id === id ? { ...x, title: title || id } : x);
      }
      return [...prev, { id, title: title || id }];
    });
  }, []);

  /** 会话列表刷新（LeftSidebar 回调）：构建 sessionId/文件名 → 显示名 映射 */
  const handleSessionsChanged = useCallback((list: SessionInfo[]) => {
    const map: Record<string, string> = {};
    for (const s of list) {
      // 显示名优先纯标题（title），回退文件名剥 session- 前缀；name 保留原名用于 /loadsession 匹配
      const display = s.title || s.name.replace(/^session-/, '');
      if (s.sessionId) map[s.sessionId] = display;
      map[s.name] = display;
    }
    setSessionNameMap(map);
  }, []);

  // 标签页标题同步：自动保存产生标题（或会话列表刷新）后，把仍是占位/sessionId 形态的 tab 标题替换为显示名
  useEffect(() => {
    setTabs(prev => {
      let changed = false;
      const next = prev.map(t => {
        const name = sessionNameMap[t.id];
        if (name && name !== t.title) {
          changed = true;
          return { ...t, title: name };
        }
        return t;
      });
      return changed ? next : prev; // 无实际变化时返回原引用，避免列表轮询触发的无谓重渲染
    });
  }, [sessionNameMap]);


  /** 新建会话：不中断当前会话，拉起独立 Agent 进程 */
  const handleNewSession = useCallback(async () => {
    const res = await api.newSession();
    if (!res?.success || !res.sessionId) return;
    currentSessionRef.current = res.sessionId;
    setCurrentSessionId(res.sessionId);
    ensureTab(res.sessionId, '新会话'); // 先占位，自动保存产生标题后由 handleSessionsChanged 替换
    setRuntimeData(null);
    clearMessages();
    setSessionReady(true); // 新会话：显示模式选择启动页
    api.sendCommand('mode:set default'); // 新会话进程从 default 开始（静默，不产生消息）
    appendMessage({ role: 'banner', content: '', createdAt: Date.now() });
    appendMessage({ role: 'blank', content: '' });
    // 请求新会话的运行时数据
    api.sendCommand('sidebar:data');
  }, [api, clearMessages, appendMessage, ensureTab]);

  /** 切换到指定会话（其他会话的 Agent 进程继续运行） */
  const handleSwitchSession = useCallback(async (sessionId: string, name?: string) => {
    if (sessionId === currentSessionRef.current) return;
    const res = await api.switchSession(sessionId, name);
    if (!res?.success) return;
    const nextId = res.sessionId || sessionId;
    currentSessionRef.current = nextId;
    // 占位标题剥掉文件名 session- 前缀（纯标题），后续由 handleSessionsChanged 映射校正
    ensureTab(nextId, name ? name.replace(/^session-/, '') : undefined);
    setCurrentSessionId(nextId);
    setRuntimeData(null);
    // 立即清空当前消息与重放状态：防止新数据到达前旧会话窗口触发误加载
    clearMessages();
    setSessionReady(false); // 防 ModePicker 在重放到达前闪现
    api.sendCommand('sidebar:data');
  }, [api, clearMessages, ensureTab]);

  /** 标签页点击：切换到对应会话 */
  const handleTabSelect = useCallback((id: string) => {
    if (id === currentSessionRef.current) return;
    handleSwitchSession(id);
  }, [handleSwitchSession]);

  /** 关闭标签页：关闭对应会话进程并移除标签；若关闭的是当前标签，切到相邻标签 */
  const handleTabClose = useCallback(async (id: string) => {
    const res = await api.closeSession(id);
    if (!res?.success) return;
    const idx = tabs.findIndex(t => t.id === id);
    setTabs(prev => prev.filter(t => t.id !== id));
    if (id === currentSessionRef.current) {
      const rest = tabs.filter(t => t.id !== id);
      const next = rest[Math.min(idx, rest.length - 1)];
      if (next) {
        await handleSwitchSession(next.id);
      } else {
        await handleNewSession(); // 最后一个标签被关：新建一个，避免停在已关闭的会话
      }
    }
  }, [api, tabs, handleSwitchSession, handleNewSession]);

  // 是否已有真实对话消息（banner/system/blank 不算）——用于新会话模式选择启动页的显示
  const hasRealMessage = messages.some((m) =>
    m.role === 'user' || m.role === 'agent' || m.role === 'tool' || m.role === 'subagent' || m.role === 'thinking',
  );


  // 桌面 Electron 原生环境异常（浏览器误开 main.html / preload 未注入）时早退提示；
  // 远程模式（Provider 存在）不早退——未连接时 window.electronAPI 未注入，
  // 由 main-content 的 remote-not-connected 占位接管，保证侧边栏「连接远程」按钮可用。
  if (!api.isAvailable && !remoteConn) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#666', fontFamily: 'sans-serif' }}>
        <p>未检测到 Electron API，请在 Electron 环境中运行此应用。</p>
      </div>
    );
  }

  return (
    <div id="app">
      <Header status={status} theme={theme} onToggleTheme={toggleTheme} onOpenSettings={() => setSettingsOpen(true)} onToggleSidebar={toggleSidebar} sidebarOpen={sidebarOpen} panelOpen={rightOpen} onTogglePanel={() => setRightOpen(v => !v)} tabs={tabs} activeTabId={currentSessionId} onTabSelect={handleTabSelect} onTabClose={handleTabClose} onTabNew={handleNewSession} />
      <RemoteStatusBar />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <div id="body-content">
        <div id="body-row">
          <LeftSidebar
            open={sidebarOpen}
            onClose={closeSidebar}
            currentSessionId={currentSessionId}
            runtimeData={runtimeData}
            onNewSession={handleNewSession}
            onSwitchSession={handleSwitchSession}
            onSessionsChanged={handleSessionsChanged}
          />
          {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}
          <div id="main-content">
            {/* 远程模式未连接（window.electronAPI 未注入）：显示引导占位，隐藏 InputBar 避免发送无效 */}
            {!apiReady ? (
              <div id="remote-not-connected" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-dim, #8c8c8c)' }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
                </svg>
                <div style={{ fontSize: 15, fontWeight: 600 }}>未连接到远程 Agent</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>点击左侧「连接远程」按钮进行配对</div>
              </div>
            ) : (
              <>
                {/* 切换会话（!sessionReady）时 Agent 在后台拉起/重放，先显示加载占位避免空白“卡住”观感 */}
                {sessionReady && !hasRealMessage ? ( // 消息列表为空时展示模式选择启动页（新建/切回空会话均适用）
                  <ModePicker api={api} sessionKey={currentSessionId} />
                ) : !sessionReady ? (
                  <div id="session-loading-area">
                    <div className="session-loading">正在加载会话…</div>
                  </div>
                ) : (
                  <MessageList key={currentSessionId} messages={messages} hasEarlier={hasEarlier} onLoadEarlier={loadEarlier} />
                )}
                <InputBar
                  processing={status.processing}
                  sessionKey={currentSessionId}
                  kbEnabled={kbEnabled}
                  thinking={status.thinking}
                  smartSearchEnabled={smartSearchEnabled}
                  thinkingEnabled={thinkingEnabled}
                  skillsList={skillsList}
                  onSend={handleSend}
                  onAbort={handleAbort}
                  onToggleKb={onToggleKb}
                  onToggleSmartSearch={onToggleSmartSearch}
                  onToggleThinking={onToggleThinking}
                />
              </>
            )}
          </div>
          <RightPanel runtimeData={runtimeData} open={rightOpen} />
        </div>
        <StatusBar
          status={status}
          toolCallTotal={status.toolCallTotal}
          totalMessages={panelState.current.totalMessages}
        />
      </div>
    </div>
  );
}



























































































