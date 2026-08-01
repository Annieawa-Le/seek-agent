import { useEffect, useCallback, useState, useRef } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { useAgentStatus } from '@/hooks/useAgentStatus.ts';
import { useMessages } from '@/hooks/useMessages.ts';
import { Header } from '@/components/Header.tsx';
import { LeftSidebar } from '@/components/LeftSidebar.tsx';
import { MessageList } from '@/components/MessageList.tsx';
import { ModePicker } from '@/components/ModePicker.tsx';
import { InputBar } from '@/components/InputBar.tsx';
import { RightPanel } from '@/components/RightPanel.tsx';
import { StatusBar } from '@/components/StatusBar.tsx';
import type { AgentMessage, SidebarRuntimeData } from '@/types/index.ts';

export function App() {
  // 当前活动会话（与主进程 currentSessionId 保持一致）
  const api = useElectronAPI();
  const [currentSessionId, setCurrentSessionId] = useState('default');
  /** 会话是否已就绪（切换会话时防 ModePicker 闪现；replace-messages 到达后置 true） */
  const [sessionReady, setSessionReady] = useState(true);
  /** 是否为新会话（仅新建会话显示模式选择启动页；切回旧会话不显示，与 DeepSeek 一致） */
  const [isFreshSession, setIsFreshSession] = useState(true);
  const currentSessionRef = useRef('default');
  useEffect(() => { currentSessionRef.current = currentSessionId; }, [currentSessionId]);
  // 当前会话的运行时数据（hooks/子agent/MCP 状态，由 sidebar:data 消息更新）
  const [runtimeData, setRuntimeData] = useState<SidebarRuntimeData | null>(null);

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
      appendMessage({ role: 'system', content: `⚠ ${error}（${sessionId}）`, createdAt: Date.now() });
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
    beginNewRound();
    appendMessage({ role: 'user', content: text, createdAt: Date.now() });
    api.sendInput(text);
  }, [api, appendMessage, beginNewRound]);

  const handleAbort = useCallback(() => {
    api.abort();
    endStreaming();
  }, [api, endStreaming]);

  /** 新建会话：不中断当前会话，拉起独立 Agent 进程 */
  const handleNewSession = useCallback(async () => {
    const res = await api.newSession();
    if (!res?.success || !res.sessionId) return;
    currentSessionRef.current = res.sessionId;
    setCurrentSessionId(res.sessionId);
    setRuntimeData(null);
    clearMessages();
    setSessionReady(true); // 新会话：显示模式选择启动页
    setIsFreshSession(true); // 仅新建会话显示启动页
    api.sendCommand('mode:set default'); // 新会话进程从 default 开始（静默，不产生消息）
    appendMessage({ role: 'banner', content: '', createdAt: Date.now() });
    appendMessage({ role: 'blank', content: '' });
    // 请求新会话的运行时数据
    api.sendCommand('sidebar:data');
  }, [api, clearMessages, appendMessage]);

  /** 切换到指定会话（其他会话的 Agent 进程继续运行） */
  const handleSwitchSession = useCallback(async (sessionId: string, name?: string) => {
    if (sessionId === currentSessionRef.current) return;
    const res = await api.switchSession(sessionId, name);
    if (!res?.success) return;
    currentSessionRef.current = res.sessionId || sessionId;
    setCurrentSessionId(res.sessionId || sessionId);
    setRuntimeData(null);
    // 立即清空当前消息与重放状态：防止新数据到达前旧会话窗口触发误加载
    clearMessages();
    setSessionReady(false); // 防 ModePicker 在重放到达前闪现
    setIsFreshSession(false); // 切回旧会话不显示启动页（模式随会话持久化，由 agent 进程恢复）
    api.sendCommand('sidebar:data');
  }, [api, clearMessages]);

  // 是否已有真实对话消息（banner/system/blank 不算）——用于新会话模式选择启动页的显示
  const hasRealMessage = messages.some((m) =>
    m.role === 'user' || m.role === 'agent' || m.role === 'tool' || m.role === 'subagent' || m.role === 'thinking',
  );


  if (!api.isAvailable) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#666', fontFamily: 'sans-serif' }}>
        <p>未检测到 Electron API，请在 Electron 环境中运行此应用。</p>
      </div>
    );
  }

  return (
    <div id="app">
      <Header status={status} ctxTokens={status.ctxTokens} theme={theme} onToggleTheme={toggleTheme} onToggleSidebar={toggleSidebar} sidebarOpen={sidebarOpen} />
      <div id="body-content">
        <div id="body-row">
          <LeftSidebar
            open={sidebarOpen}
            onClose={closeSidebar}
            currentSessionId={currentSessionId}
            runtimeData={runtimeData}
            onNewSession={handleNewSession}
            onSwitchSession={handleSwitchSession}
          />
          {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}
          <div id="main-content">
            {/* 切换会话（!sessionReady）时 Agent 在后台拉起/重放，先显示加载占位避免空白“卡住”观感 */}
            {sessionReady && isFreshSession && !hasRealMessage ? (
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
          </div>
          <RightPanel runtimeData={runtimeData} />
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














































