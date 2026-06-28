/**
 * electron-bridge.ts — WebUIBridge for Electron
 *
 * 替代 TerminalUI，通过 stdio JSON 协议与 Electron 主进程通信。
 * 主进程再转发到渲染进程，实现 Web 界面。
 */
import { toWebUI } from './tools/raw-bulk-formatters';

import type { UIMessage } from './ui';

// ═════════════════════════════════════════════════════
// 消息类型（与 TerminalUI 的 UIMessage 兼容）
// ═════════════════════════════════════════════════════

export interface BridgeMessage {
 role: 'user' | 'agent' | 'system' | 'tool' | 'divider' | 'banner' | 'blank' | 'subagent';
 content: string;
 createdAt?: number;
 subagentName?: string;
 collapsed?: boolean;
 toolMeta?: { toolName: string; args: Record<string, unknown> };
 doNotRender?: boolean;
 /** 工具结果的完整原始输出（未截断的原始内容） */
 fullOutput?: string;
  /** 结构化功能数据（工具结果，供多端消费） */
  rawBulk?: Record<string, unknown>;
}

// ═════════════════════════════════════════════════════
// stdio JSON 协议类型
// ═════════════════════════════════════════════════════

/** 子进程 → 主进程 */
export type ChildToParent =
  | { type: 'message'; role: BridgeMessage['role']; content: string; subagentName?: string; toolMeta?: BridgeMessage['toolMeta']; toolCallHtml?: string; toolResultHtml?: string; fullOutput?: string; rawBulk?: Record<string, unknown> }
  | { type: 'state'; processing: boolean }
  | { type: 'context'; chars: number; tokens: number }
  | { type: 'tool-call'; count: number }
  | { type: 'thinking'; active: boolean }
  | { type: 'listen'; name: string | null }
  | { type: 'append'; content: string }
  | { type: 'remove-last-agent' }
  | { type: 'collapse-tools'; entries: Array<{ msgIndex: number; toolName: string; args: Record<string, unknown> }> }
  | { type: 'clear-messages' }
  | { type: 'divider' }
  | { type: 'blank' }
  | { type: 'init-done' }
  | { type: 'subagent'; name: string; content: string }
  | { type: 'kb-build'; phase: 'building' | 'done' | 'failed'; message: string }
  | { type: 'exit' };

/** 主进程 → 子进程 */
export type ParentToChild =
  | { type: 'input'; content: string; id: string }
  | { type: 'command'; cmd: string; id: string }
  | { type: 'exit' }
  | { type: 'abort' };

// ═════════════════════════════════════════════════════
// ElectronUIBridge
// ═════════════════════════════════════════════════════

export class ElectronUIBridge {
 /** 用于与主进程通信的写流（stdout） */
 private send: (msg: ChildToParent) => void;
 /** abort 控制 */
 private abortController: AbortController | null = null;

 /** 消息列表（用于兼容 agent 对 ui.messages 的引用） */
 messages: BridgeMessage[] = [];

 /** 处理中的 spinner 状态 */
 private thinkingActive = false;
 private listenActiveName: string | null = null;

 /** 当前是否正在处理 AI 请求 */
 isProcessing = false;

 // ─── 回调 ───
 onSubmit: ((input: string) => void) | null = null;
 onExit: (() => void) | null = null;
 onCommand: ((cmd: string) => void) | null = null;

 constructor() {
 // 使用 stdout 发送 JSON 消息（每行一个 JSON）
 this.send = (msg: ChildToParent) => {
 try {
 process.stdout.write(JSON.stringify(msg) + '\n');
 } catch {
 // stdout 关闭时静默忽略
 }
 };
 }

 /** 获取 AbortController 的 signal 是否已中断 */
 get isAborted(): boolean {
 return this.abortController?.signal.aborted ?? false;
 }

 /** 创建一个新的 AbortController（先取消旧的） */
 createAbortController(): AbortController {
 if (this.abortController) {
 this.abortController.abort();
 }
 this.abortController = new AbortController();
 return this.abortController;
 }

 // ═══════════════════════════════════════════════════
 // 消息发布
 // ═══════════════════════════════════════════════════

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content, createdAt: Date.now() });
    this.send({ type: 'message', role: 'user', content });
  }

  addAgentMessage(content: string): void {
  this.messages.push({ role: 'agent', content, createdAt: Date.now() });
  this.send({ type: 'message', role: 'agent', content });
  }

  addToolMessage(content: string, toolMeta?: { toolName: string; args: Record<string, unknown> }, fullOutput?: string, rawBulk?: Record<string, unknown>): void {
    let toolCallHtml: string | undefined;
    let toolResultHtml: string | undefined;
    if (toolMeta) {
      toolCallHtml = formatToolCallHtml(toolMeta.toolName, toolMeta.args);
      console.error('[bridge] toolMETA:', toolMeta.toolName, toolCallHtml?.slice(0,100));
    } else if (rawBulk) {
      console.error('[bridge] RAWBULK type:', (rawBulk as any).type, 'keys:', Object.keys(rawBulk as any).join(','));
      const webUIResult = toWebUI(rawBulk as any);
      toolResultHtml = (webUIResult as any).html as string;
    }
    this.messages.push({ role: 'tool', content, toolMeta, fullOutput, rawBulk, createdAt: Date.now() });
    this.send({ type: 'message', role: 'tool', content, toolMeta, toolCallHtml, toolResultHtml, fullOutput, rawBulk });
  }

  /** 发送知识库构建状态到 UI */
  addKbStatus(phase: 'building' | 'done' | 'failed', message: string): void {
    this.send({ type: 'kb-build', phase, message });
  }

  addSystemMessage(content: string): void {
  this.messages.push({ role: 'system', content, createdAt: Date.now() });
  this.send({ type: 'message', role: 'system', content });
  }

 addSubAgentMessage(name: string, content: string): void {
 const last = this.messages[this.messages.length - 1];
 if (last && last.role === 'subagent' && last.subagentName === name) {
 last.content += `\n\n---\n${content}`;
 } else {
 this.messages.push({ role: 'subagent', content, subagentName: name, createdAt: Date.now() });
 }
 this.send({ type: 'subagent', name, content });
 }

 addDivider(): void {
 this.messages.push({ role: 'divider', content: '' });
 this.send({ type: 'divider' });
 }

 addBlankLine(): void {
 this.messages.push({ role: 'blank', content: '' });
 this.send({ type: 'blank' });
 }

 /** 流式追加（追加到当前空气泡，不新建气泡） */
 appendToLastAgent(text: string): void {
 for (let i = this.messages.length - 1; i >= 0; i--) {
 if (this.messages[i].role === 'agent') {
 this.messages[i].content += text;
 break;
 }
 }
 this.send({ type: 'append', content: text });
 }

 /** 移除最后一条 agent 消息 */
 removeLastAgent(): void {
 for (let i = this.messages.length - 1; i >= 0; i--) {
 if (this.messages[i].role === 'agent') {
 this.messages.splice(i, 1);
 break;
 }
 }
 this.send({ type: 'remove-last-agent' });
 }

 /** 批量折叠工具消息 */
 collapseToolMessages(entries: Array<{ msgIndex: number; toolName: string; args: Record<string, unknown> }>): void {
 for (const entry of entries) {
 const msg = this.messages[entry.msgIndex];
 if (msg && msg.role === 'tool') {
 msg.collapsed = true;
 msg.toolMeta = { toolName: entry.toolName, args: entry.args };
 }
 const callIdx = entry.msgIndex - 1;
 if (callIdx >= 0) {
 const callMsg = this.messages[callIdx];
 if (callMsg && callMsg.role === 'tool' && !callMsg.toolMeta) {
 callMsg.doNotRender = true;
 }
 }
 }
 this.send({ type: 'collapse-tools', entries });
 }

 clearMessages(): void {
 this.messages = [];
 this.send({ type: 'clear-messages' });
 }

  /** 批量替换消息列表（用于加载会话时恢复显示） */
  replaceMessages(msgs: UIMessage[]): void {
    this.messages = msgs.map(m => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt || Date.now(),
      subagentName: m.subagentName,
      collapsed: m.collapsed,
      toolMeta: m.toolMeta,
    }));
    // 通知渲染进程清空并逐个重建
    this.send({ type: 'clear-messages' });
    for (const msg of this.messages) {
      this.send({ type: 'message', role: msg.role, content: msg.content });
      if (msg.role === 'subagent') {
        this.send({ type: 'subagent', name: msg.subagentName || '', content: msg.content });
      }
    }
  }

 // ═══════════════════════════════════════════════════
 // 状态控制
 // ═══════════════════════════════════════════════════

 setProcessing(processing: boolean): void {
 this.isProcessing = processing;
 if (!processing) {
 this.abortController = null;
 }
 this.send({ type: 'state', processing });
 }

 setContextLength(chars: number, tokens: number = 0): void {
 this.send({ type: 'context', chars, tokens });
 }

 setToolCallCount(n: number): void {
 this.send({ type: 'tool-call', count: n });
 }

 startThinkingSpinner(): void {
 this.thinkingActive = true;
 this.send({ type: 'thinking', active: true });
 }

 stopThinkingSpinner(): void {
 this.thinkingActive = false;
 this.send({ type: 'thinking', active: false });
 }

 showListenStatus(name: string): void {
 this.listenActiveName = name;
 this.send({ type: 'listen', name });
 }

 hideListenStatus(): void {
 this.listenActiveName = null;
 this.send({ type: 'listen', name: null });
 }

 // ═══════════════════════════════════════════════════
 // 通信设置：绑定 stdin 读取
 // ═══════════════════════════════════════════════════

 /**
 * 启动 stdin 监听，从主进程接收输入/命令
 */
 startListening(): void {
 const rl = (async () => {
 let buffer = '';
 for await (const chunk of process.stdin) {
 buffer += chunk.toString();
 const lines = buffer.split('\n');
 buffer = lines.pop() ?? '';

 for (const line of lines) {
 if (!line.trim()) continue;
 try {
 const msg: ParentToChild = JSON.parse(line);
 this.handleParentMessage(msg);
 } catch {
 // 解析失败，忽略
 }
 }
 }
 })();

 // 防止未捕获的 rejection
 rl.catch(() => {});
 }

 private handleParentMessage(msg: ParentToChild): void {
 switch (msg.type) {
 case 'input':
 if (this.onSubmit) {
 this.onSubmit(msg.content);
 }
 break;
 case 'command':
 if (this.onCommand) {
 this.onCommand(msg.cmd);
 }
 break;
 case 'abort':
 if (this.abortController) {
 this.abortController.abort();
 }
 break;
 case 'exit':
 if (this.onExit) {
 this.onExit();
 }
 break;
 }
 }

 /** 发送初始化完成信号 */
 emitReady(): void {
 this.send({ type: 'init-done' });
 }
}






/** 从 toolMeta 生成干净的 HTML 工具调用标签（不经过 ANSI 转义码） */
function formatToolCallHtml(toolName: string, args: Record<string, unknown>): string {
  const argStr = Object.entries(args).map(([k, v]) => {
    const vs = typeof v === 'string' ? v : JSON.stringify(v);
    return vs.length > 60 ? `${k}=${vs.slice(0, 60)}…` : `${k}=${vs}`;
  }).join(', ');
  return `<span class="tool-call-label"><span class="tool-call-name">${escapeHtml(toolName)}</span> <span class="tool-call-args">${escapeHtml(argStr)}</span></span>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}





















