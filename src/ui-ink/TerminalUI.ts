import type { UIState, UIMessage } from './types';
import type { RawBulk } from '../tools/raw-bulk-types';
import { WHALE } from '../assets/whale';

/** render() 返回的 Ink 实例最小接口 */
interface InkInstance {
  unmount: () => void;
  waitUntilExit: Promise<unknown>;
  rerender?: (node?: unknown) => void;
}

/** Ink 版 TerminalUI：公开接口与旧版完全一致，内部用 Ink(React) 渲染 */
export class TerminalUI {
  // ─── 公开字段（外部直接访问） ───
  messages: UIMessage[] = [];
  onSubmit: ((input: string) => void) | null = null;
  onExit: (() => void) | null = null;
  /** 快捷键触发的命令回调：cmd 为命令名 */
  onCommand: ((cmd: string) => void) | null = null;
  /** 实际（非缓存）工具调用数 */
  toolCallCount = 0;

  // ─── 输入状态 ───
  private inputBuffer = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;

  // ─── 运行状态 ───
  private isProcessing = false;
  private running = false;
  private promptText = '❯ ';
  private abortController: AbortController | null = null;

  // ─── 上下文统计 ───
  private contextChars = 0;
  private contextTokens = 0;
  private maxContextChars = 0;

  // ─── 思考 / spinner / 审查状态 ───
  private thinkingActive = false;
  private thinkingText = '';
  private spinnerIndex = 0;
  private thinkingInterval: ReturnType<typeof setInterval> | null = null;
  private listenInterval: ReturnType<typeof setInterval> | null = null;
  private listenActiveName: string | null = null;

  // ─── 滚动状态（按消息条数） ───
  private scrollOffset = 0;

  // ─── Ink 渲染桥接：useSyncExternalStore 订阅 ───
  private listeners = new Set<() => void>();
  private version = 0;
  private inkInstance: InkInstance | null = null;

  constructor() {
    // noop：Ink 在 start() 时挂载
  }

  /** useSyncExternalStore 订阅回调 */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** useSyncExternalStore 快照：返回稳定版本号，变化触发重渲染 */
  getSnapshot = (): number => this.version;

  /** 内部：状态变更后通知 React 重渲染 */
  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** 获取当前渲染快照（组件每次渲染时读取） */
  getState(): UIState {
    return {
      messages: this.messages,
      input: this.inputBuffer,
      cursorPos: this.cursorPos,
      historyIndex: this.historyIndex,
      isProcessing: this.isProcessing,
      thinkingActive: this.thinkingActive,
      thinkingText: this.thinkingText,
      spinnerIndex: this.spinnerIndex,
      listenName: this.listenActiveName,
      contextChars: this.contextChars,
      contextTokens: this.contextTokens,
      maxContextChars: this.maxContextChars,
      toolCallCount: this.toolCallCount,
      scrollOffset: this.scrollOffset,
      promptText: this.promptText,
    };
  }

  // ═══════════════════════════════════════════════════
  // 启动 / 停止
  // ═══════════════════════════════════════════════════

  start(promptText = '❯ '): void {
    if (this.running) return;
    this.promptText = promptText;
    this.running = true;
    this.messages = [
      { role: 'banner', content: WHALE },
      { role: 'system', content: '✦ Seek Agent 已启动。输入 /exit 退出，/clear 清屏。PageUp/PageDown 或滚轮滚动历史。' },
    ];
    this.notify();
    void this.mountInk();
  }

  /** 异步挂载 Ink 渲染树（避免 start 内 await 阻塞） */
  private async mountInk(): Promise<void> {
    const { render } = await import('ink');
    const { App } = await import('./App');
    const element = (await import('react')).createElement(App, { ui: this });
    const instance = render(element);
    this.inkInstance = instance as unknown as InkInstance;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopThinkingSpinner();
    this.hideListenStatus();
    try {
      this.inkInstance?.unmount();
      this.inkInstance?.unmount();
    } catch {
      // unmount 失败不阻塞退出
    }
    this.inkInstance = null;
    this.notify();
  }

  // ═══════════════════════════════════════════════════
  // 消息添加（接口与旧版一致）
  // ═══════════════════════════════════════════════════

  addUserMessage(content: string): void {
    this.messages = [...this.messages, { role: 'user', content, createdAt: Date.now() }];
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = this.history.length;
    this.resetScroll();
    this.notify();
  }

  addSubAgentMessage(name: string, content: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'subagent' && last.subagentName === name) {
      this.messages = [
        ...this.messages.slice(0, -1),
        { ...last, content: last.content + `\n\n---\n${content}` },
      ];
    } else {
      this.messages = [...this.messages, { role: 'subagent', content, subagentName: name, createdAt: Date.now() }];
    }
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.resetScroll();
    this.notify();
  }

  addInstructorMessage(content: string, name?: string): void {
    this.messages = [...this.messages, { role: 'instructor', content, subagentName: name, createdAt: Date.now() }];
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.resetScroll();
    this.notify();
  }

  addAgentMessage(content: string): void {
    this.messages = [...this.messages, { role: 'agent', content, createdAt: Date.now() }];
    this.resetScroll();
    this.notify();
  }

  addToolMessage(
    content: string,
    toolMeta?: { toolName: string; args: Record<string, unknown> },
    _fullOutput?: string,
    rawBulk?: RawBulk,
  ): void {
    this.messages = [...this.messages, { role: 'tool', content, toolMeta, rawBulk, createdAt: Date.now() }];
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.notify();
  }

  collapseToolMessages(entries: Array<{ msgIndex: number; toolName: string; args: Record<string, unknown> }>): void {
    const next = this.messages.map((msg, i) => {
      const entry = entries.find(e => e.msgIndex === i);
      if (entry && msg.role === 'tool') {
        return { ...msg, collapsed: true, toolMeta: { toolName: entry.toolName, args: entry.args } };
      }
      // 标记紧挨在前面的「调用中」消息为不渲染
      const callEntry = entries.find(e => e.msgIndex === i + 1);
      if (callEntry && msg.role === 'tool' && !msg.toolMeta) {
        return { ...msg, doNotRender: true };
      }
      return msg;
    });
    this.messages = next;
    this.notify();
  }

  addDivider(): void {
    this.messages = [...this.messages, { role: 'divider', content: '' }];
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.notify();
  }

  addBlankLine(): void {
    this.messages = [...this.messages, { role: 'blank', content: '' }];
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.notify();
  }

  addSystemMessage(content: string): void {
    this.messages = [...this.messages, { role: 'system', content, createdAt: Date.now() }];
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.notify();
  }

  appendToLastAgent(text: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'agent') {
        const target = this.messages[i];
        this.messages = [
          ...this.messages.slice(0, i),
          { ...target, content: target.content + text },
          ...this.messages.slice(i + 1),
        ];
        break;
      }
    }
    this.notify();
  }

  removeLastAgent(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'agent') {
        this.messages = [...this.messages.slice(0, i), ...this.messages.slice(i + 1)];
        break;
      }
    }
    this.notify();
  }

  // ═══════════════════════════════════════════════════
  // 状态控制
  // ═══════════════════════════════════════════════════

  setProcessing(processing: boolean): void {
    this.isProcessing = processing;
    if (!processing) this.abortController = null;
    this.notify();
  }

  startThinkingSpinner(): void {
    if (this.thinkingInterval) return;
    this.spinnerIndex = 0;
    this.thinkingInterval = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % 10;
      this.notify();
    }, 120);
  }

  stopThinkingSpinner(): void {
    if (this.thinkingInterval) {
      clearInterval(this.thinkingInterval);
      this.thinkingInterval = null;
    }
  }

  startThinking(): void {
    this.thinkingActive = true;
    this.notify();
  }

  feedThinking(content: string): void {
    this.thinkingText += content;
    this.notify();
  }

  endThinking(): void {
    this.thinkingActive = false;
    this.notify();
  }

  isThinkingActive(): boolean {
    return this.thinkingActive;
  }

  showListenStatus(name: string): void {
    this.listenActiveName = name;
    if (!this.listenInterval) {
      this.listenInterval = setInterval(() => {
        this.spinnerIndex = (this.spinnerIndex + 1) % 10;
        this.notify();
      }, 120);
    }
    this.notify();
  }

  hideListenStatus(): void {
    this.listenActiveName = null;
    if (this.listenInterval) {
      clearInterval(this.listenInterval);
      this.listenInterval = null;
    }
    this.notify();
  }

  createAbortController(): AbortController {
    this.abortController = new AbortController();
    return this.abortController;
  }

  get abortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  get isAborted(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }

  clearMessages(): void {
    this.messages = [];
    this.scrollOffset = 0;
    this.resetContextLength();
    this.addBlankLine();
  }

  replaceMessages(msgs: UIMessage[]): void {
    this.messages = msgs;
    this.scrollOffset = 0;
    this.notify();
  }

  getCurrentInput(): string {
    return this.inputBuffer;
  }

  setContextLength(chars: number, tokens = 0): void {
    this.contextChars = chars;
    this.contextTokens = tokens;
    if (chars > this.maxContextChars) this.maxContextChars = chars;
    this.notify();
  }

  resetContextLength(): void {
    this.contextChars = 0;
    this.contextTokens = 0;
    this.maxContextChars = 0;
  }

  setToolCallCount(n: number): void {
    this.toolCallCount = n;
    this.notify();
  }

  setInput(text: string): void {
    this.inputBuffer = text;
    this.cursorPos = text.length;
    this.notify();
  }

  // ═══════════════════════════════════════════════════
  // 滚动
  // ═══════════════════════════════════════════════════

  /** 向上滚动（查看更早消息），step 为消息条数 */
  scrollUp(step: number): void {
    this.scrollOffset = Math.min(this.messages.length, this.scrollOffset + step);
    this.notify();
  }

  scrollDown(step: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - step);
    this.notify();
  }

  resetScroll(): void {
    this.scrollOffset = 0;
  }

  isAtBottom(): boolean {
    return this.scrollOffset === 0;
  }

  // ═══════════════════════════════════════════════════
  // 按键处理（由 Ink useInput 调用）
  // ═══════════════════════════════════════════════════

  handleKey(input: string, key: { upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean; return?: boolean; escape?: boolean; ctrl?: boolean; shift?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean; meta?: boolean }): void {
    const isCtrl = !!key.ctrl;

    // ─── Ctrl+C：AI 运行时中断当前轮次，否则退出 ───
    if (isCtrl && input === 'c') {
      if (this.isProcessing && this.abortController) {
        this.abortController.abort();
        this.addToolMessage('■ 用户中断了 AI 处理');
      } else {
        this.stop();
        if (this.onExit) this.onExit();
        else process.exit(0);
      }
      return;
    }

    // ─── Ctrl+L 清屏 ───
    if (isCtrl && input === 'l') {
      this.clearMessages();
      return;
    }

    // ─── Ctrl+Q 强制清理工具调用 ───
    if (isCtrl && input === 'q') {
      if (this.onCommand) this.onCommand('memory_shorten');
      return;
    }

    // ─── Ctrl+S 保存会话 ───
    if (isCtrl && input === 's') {
      if (this.onCommand) this.onCommand('save_session');
      return;
    }

    // ─── Ctrl+W 强制折叠 3 轮前的内容 ───
    if (isCtrl && input === 'w') {
      if (this.onCommand) this.onCommand('memory_focus');
      return;
    }

    // ─── Ctrl+U 清空输入 ───
    if (isCtrl && input === 'u') {
      this.inputBuffer = '';
      this.cursorPos = 0;
      this.notify();
      return;
    }

    // ─── Ctrl+D 退出 ───
    if (isCtrl && input === 'd') {
      this.stop();
      if (this.onExit) this.onExit();
      else process.exit(0);
      return;
    }

    // ─── PageUp / PageDown 滚动 ───
    if (key.pageUp) {
      this.scrollUp(5);
      return;
    }
    if (key.pageDown) {
      this.scrollDown(5);
      return;
    }

    // ─── 上下箭头：历史浏览 ───
    if (key.upArrow && !isCtrl) {
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.inputBuffer = this.history[this.historyIndex];
        this.cursorPos = this.inputBuffer.length;
      }
      this.notify();
      return;
    }
    if (key.downArrow && !isCtrl) {
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++;
        this.inputBuffer = this.history[this.historyIndex];
        this.cursorPos = this.inputBuffer.length;
      } else {
        this.historyIndex = this.history.length;
        this.inputBuffer = '';
        this.cursorPos = 0;
      }
      this.notify();
      return;
    }

    // ─── 左右箭头：光标移动 ───
    if (key.leftArrow) {
      if (this.cursorPos > 0) this.cursorPos--;
      this.notify();
      return;
    }
    if (key.rightArrow) {
      if (this.cursorPos < this.inputBuffer.length) this.cursorPos++;
      this.notify();
      return;
    }

    if (key.home) {
      this.cursorPos = 0;
      this.notify();
      return;
    }
    if (key.end) {
      this.cursorPos = this.inputBuffer.length;
      this.notify();
      return;
    }

    // ─── Enter ───
    if (key.return) {
      const trimmed = this.inputBuffer.trim();
      if (!trimmed) {
        this.notify();
        return;
      }
      if (!this.isProcessing) {
        this.history.push(trimmed);
        this.historyIndex = this.history.length;
      }
      const text = trimmed;
      this.inputBuffer = '';
      this.cursorPos = 0;
      this.notify();
      if (this.onSubmit) Promise.resolve(this.onSubmit(text)).catch(() => {});
      return;
    }

    // ─── Backspace ───
    if (key.backspace) {
      if (this.cursorPos > 0) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos - 1) +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos--;
      }
      this.notify();
      return;
    }

    // ─── Delete ───
    if (key.delete) {
      if (this.cursorPos < this.inputBuffer.length) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          this.inputBuffer.slice(this.cursorPos + 1);
      }
      this.notify();
      return;
    }

    // ─── Tab / Ctrl+I 强制中断所有子 agent ───
    if (key.tab) {
      if (this.onCommand) this.onCommand('interrupt_agents');
      return;
    }

    if (key.escape) {
      return;
    }

    // ─── 可打印字符输入（含粘贴多字符） ───
    if (input && !isCtrl && !key.meta) {
      // 过滤纯控制字符（Ink 对未知转义序列可能传入垃圾字符）
      const printable = input.replace(/[\x00-\x1f\x7f]/g, '');
      if (printable) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          printable +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos += printable.length;
        this.historyIndex = this.history.length;
      }
      this.notify();
    }
  }
}





