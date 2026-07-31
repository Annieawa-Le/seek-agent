import { useEffect, useCallback, useState, useRef } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { useAgentStatus } from '@/hooks/useAgentStatus.ts';
import { useMessages } from '@/hooks/useMessages.ts';
import { Header } from '@/components/Header.tsx';
import { LeftSidebar } from '@/components/LeftSidebar.tsx';
import { MessageList } from '@/components/MessageList.tsx';
import { InputBar } from '@/components/InputBar.tsx';
import { RightPanel } from '@/components/RightPanel.tsx';
import { StatusBar } from '@/components/StatusBar.tsx';
import { FolderSelector } from '@/components/FolderSelector.tsx';
import type { AgentMessage, SidebarRuntimeData } from '@/types/index.ts';

export function App() {
  // 当前活动会话（与主进程 currentSessionId 保持一致）
  const api = useElectronAPI();
  const [currentSessionId, setCurrentSessionId] = useState('default');
  const currentSessionRef = useRef('default');
  useEffect(() => { currentSessionRef.current = currentSessionId; }, [currentSessionId]);
  // 当前会话的运行时数据（hooks/子agent/MCP 状态，由 sidebar:data 消息更新）
  const [runtimeData, setRuntimeData] = useState<SidebarRuntimeData | null>(null);

  const status = useAgentStatus(currentSessionId);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
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
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
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
    clearMessages,
    endStreaming,
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
      appendThinkingDelta, endThinking, clearMessages]);

  useEffect(() => {
    const unsub = api.onMessage(handleMessage);
    return () => unsub();
  }, [api, handleMessage]);

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
    appendMessage({ role: 'banner', content: '', createdAt: Date.now() });
    appendMessage({ role: 'system', content: `新会话已创建（${res.sessionId}）。`, createdAt: Date.now() });
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
    // 会话内容由 agent 进程通过 clear-messages + 消息流重放；请求运行时数据
    api.sendCommand('sidebar:data');
  }, [api]);

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
            <div id="main-toolbar">
              <span className="toolbar-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2 7h7l-5.5 4 2 7L12 16l-5.5 4 2-7L3 9h7z"/></svg></span>
              <span className="toolbar-context">
                New session in <FolderSelector />
                with <span className="ctx-tool"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: 'middle', marginRight: 3}}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Copilot CLI ▼</span>
              </span>
            </div>
            <MessageList messages={messages} />
            <InputBar
              processing={status.processing}
              thinking={status.thinking}
              kbEnabled={kbEnabled}
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
          <RightPanel />
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











