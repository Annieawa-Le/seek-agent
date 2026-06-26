import { useEffect, useCallback, useState } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { useAgentStatus } from '@/hooks/useAgentStatus.ts';
import { useMessages } from '@/hooks/useMessages.ts';
import { Header } from '@/components/Header.tsx';
import { LeftSidebar } from '@/components/LeftSidebar.tsx';
import { MessageList } from '@/components/MessageList.tsx';
import { InputBar } from '@/components/InputBar.tsx';
import { RightPanel } from '@/components/RightPanel.tsx';
import { StatusBar } from '@/components/StatusBar.tsx';
import type { AgentMessage } from '@/types/index.ts';

export function App() {
  const api = useElectronAPI();
  const status = useAgentStatus();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // 同步主题到 data-theme 属性
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);
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
  } = useMessages();

  const handleMessage = useCallback((msg: AgentMessage) => {
    switch (msg.type) {
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
      setToolCallCount, endStreaming, removeLastAgent]);

  useEffect(() => {
    const unsub = api.onMessage(handleMessage);
    return () => unsub();
  }, [api, handleMessage]);

  // 欢迎消息
  useEffect(() => {
    appendMessage({ role: 'banner', content: '', createdAt: Date.now() });
    appendMessage({ role: 'system', content: 'Seek Agent 已启动。输入消息开始对话。', createdAt: Date.now() });
    appendMessage({ role: 'blank', content: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback((text: string) => {
    // 本地立即显示用户消息（原版 renderer.js 的行为）
    appendMessage({ role: 'user', content: text, createdAt: Date.now() });
    api.sendInput(text);
  }, [api, appendMessage]);

  const handleAbort = useCallback(() => {
    api.abort();
    endStreaming();
  }, [api, endStreaming]);

  const handleNewSession = useCallback(() => {
    if (status.processing) {
      api.abort();
      endStreaming();
    }
    clearMessages();
    api.sendCommand('new_session');
  }, [api, clearMessages, endStreaming, status.processing]);

  if (!api.isAvailable) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#666', fontFamily: 'sans-serif' }}>
        <p>未检测到 Electron API，请在 Electron 环境中运行此应用。</p>
      </div>
    );
  }

  return (
    <div id="app">
      <Header status={status} ctxTokens={status.ctxTokens} theme={theme} onToggleTheme={toggleTheme} />
      <div id="body-content">
        <div id="body-row">
          <LeftSidebar onNewSession={handleNewSession} />
          <div id="main-content">
            <div id="main-toolbar">
              <span className="toolbar-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2 7h7l-5.5 4 2 7L12 16l-5.5 4 2-7L3 9h7z"/></svg></span>
              <span className="toolbar-context">
                New session in <span className="ctx-folder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: 'middle', marginRight: 3}}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> seek-agent ▼</span>
                with <span className="ctx-tool"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: 'middle', marginRight: 3}}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Copilot CLI ▼</span>
              </span>
            </div>
            <MessageList messages={messages} />
            <InputBar
              processing={status.processing}
              thinking={status.thinking}
              onSend={handleSend}
              onAbort={handleAbort}
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















