import { useEffect, useMemo, useRef, useState } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { SubagentStreamMsg } from '@/types/index.ts';
import type { DisplayMessage } from '@/hooks/useMessages.ts';
import { MessageItem } from './MessageItem.tsx';
import { toNoteMessages, buildSessionFile } from '@/utils/subagent-note-utils.ts';

/**
 * 子 Agent 便条窗体 — 叠加在主消息区上的浮动面板
 *
 * 以「消息」的颗粒度实时渲染某个子 Agent 的消息流（任务 / assistant 文本 /
 * 工具调用 / 工具结果 / 提交），渲染方式与主 Agent 消息一致（MessageItem）。
 *
 * 右下角两个按钮：
 *   - 停止：向 agent 进程发 agent:stop <peer>，中断子 Agent 当前执行（不销毁状态）
 *   - 保存（本地化）：把当前消息流导出为 json-session 文件，
 *     未完成的工具调用自动补一条 toolResult（"工具调用被中断"）。
 */

/** 便条窗体内的静态消息列表（独立滚动容器，避免与主消息区 #message-area 冲突） */
function NoteMessageList({ messages }: { messages: DisplayMessage[] }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  useEffect(() => {
    areaRef.current?.scrollTo({ top: areaRef.current.scrollHeight, behavior: 'auto' });
  }, [lastMsg, messages.length]);
  return (
    <div className="subagent-note-messages" ref={areaRef}>
      {messages.map(msg => <MessageItem key={msg.id} msg={msg} />)}
    </div>
  );
}

export function SubagentNotePanel({ peer, stream, onClose }: {
  peer: string;
  stream: SubagentStreamMsg[];
  onClose: () => void;
}) {
  const api = useElectronAPI();
  const messages = useMemo(() => toNoteMessages(stream), [stream]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  // 便条窗体打开期间加速轮询 sidebar:data（子 Agent 消息流实时刷新）
  useEffect(() => {
    const t = setInterval(() => api.sendCommand('sidebar:data'), 2000);
    api.sendCommand('sidebar:data'); // 立即拉一次最新流
    return () => clearInterval(t);
  }, [api]);

  const handleStop = () => {
    api.sendCommand(`agent:stop ${peer}`);
    setStopped(true);
  };

  const handleSave = async () => {
    const file = buildSessionFile(peer, stream);
    const res = await api.saveSubagentSession(file);
    if (res?.ok) {
      setSavedMsg(`已保存：${res.path || 'json-session 文件'}`);
    } else {
      setSavedMsg(`保存失败：${res?.error || '未知错误'}`);
    }
    setTimeout(() => setSavedMsg(null), 4000);
  };

  return (
    <div className="subagent-note-overlay" onClick={onClose}>
      <div className="subagent-note-panel" onClick={e => e.stopPropagation()}>
        <div className="subagent-note-header">
          <span className="subagent-note-title">便条 · {peer}</span>
          <span className="subagent-note-sub">消息级工作进度</span>
          <button className="subagent-note-close" onClick={onClose} title="关闭便条">×</button>
        </div>
        <div className="subagent-note-body">
          {messages.length === 0
            ? <div className="panel-empty">暂无消息（子 Agent 尚未产生输出）</div>
            : <NoteMessageList messages={messages} />}
        </div>
        <div className="subagent-note-footer">
          {savedMsg && <span className="subagent-note-saved">{savedMsg}</span>}
          {stopped && <span className="subagent-note-stopped">已发送停止指令</span>}
          <span className="subagent-note-spacer" />
          <button className="note-icon-btn" onClick={handleStop} title="停止该子 Agent（中断当前执行，不销毁）">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
          <button className="note-icon-btn" onClick={handleSave} title="保存为 json-session 文件（未完成的工具调用自动补 toolResult）">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}






