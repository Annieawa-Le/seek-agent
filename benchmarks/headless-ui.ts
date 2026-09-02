/**
 * benchmarks/headless-ui.ts — 无人值守跑分用的 HeadlessUI
 *
 * 实现 CLIAAgent 实际调用的全部 TerminalUI 接口（agent.ts 约 79 处调用点）。
 * 不渲染任何东西，只记录事件（assistant 文本、工具调用、usage 摘要），
 * 供跑分 harness 在任务结束后提取结果与指标。
 *
 * 中断语义：abort() 置 isAborted + 触发 AbortController，
 * agent 的处理循环（while !ui.isAborted）与正在进行的 streamText 都会在安全点停止。
 */

export interface HeadlessUiMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

export class HeadlessUI {
  /** 置 true 后 agent 处理循环与工具调用会在安全点停止（超时中断路径） */
  isAborted = false;
  messages: HeadlessUiMessage[] = [];
  /** assistant 累计正文（流式增量拼接） */
  assistantText = '';
  /** 工具调用次数 */
  toolCallCount = 0;
  /** 最后一次 setUsageSummary 收到的 usage 摘要（dsh 四桶 + 缓存命中率） */
  usageSummary: Record<string, unknown> | null = null;
  /** 扁平工具日志：toolName + args + 结果摘要 */
  toolLog: Array<{ toolName: string; args: unknown; result: string }> = [];

  private abortController = new AbortController();

  /** 超时/外部中断：触发 agent 安全停止 */
  abort(): void {
    this.isAborted = true;
    this.abortController.abort();
  }

  createAbortController(): AbortController {
    return this.abortController;
  }

  addInstructorMessage(_content: string, _name: string): void {
    // 跑分不启用 instructor，忽略
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAgentMessage(content: string): void {
    this.messages.push({ role: 'assistant', content });
    this.assistantText += content;
  }

  appendToLastAgent(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant') last.content += text;
    else this.messages.push({ role: 'assistant', content: text });
    this.assistantText += text;
  }

  clearMessages(): void {
    this.messages = [];
  }

  addBlankLine(): void {
    /* noop */
  }

  setProcessing(_p: boolean): void {
    /* noop */
  }

  addToolMessage(
    text: string,
    meta?: { toolName?: string; args?: unknown },
    sout?: string,
    _rawBulk?: unknown,
  ): void {
    const toolName = meta?.toolName;
    if (toolName) this.toolCallCount++;
    this.messages.push({ role: 'tool', content: text, toolName });
    if (toolName) {
      this.toolLog.push({ toolName, args: meta?.args, result: sout ?? text });
    }
  }

  startThinking(): void {
    /* noop */
  }

  feedThinking(_t: string): void {
    /* noop */
  }

  endThinking(): void {
    /* noop */
  }

  isThinkingActive(): boolean {
    return false;
  }

  startThinkingSpinner(): void {
    /* noop */
  }

  stopThinkingSpinner(): void {
    /* noop */
  }

  removeLastAgent(): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant') this.messages.pop();
  }

  collapseToolMessages(_q: unknown[]): void {
    /* noop */
  }

  setToolCallCount(n: number): void {
    this.toolCallCount = n;
  }

  setUsageSummary(s: Record<string, unknown>): void {
    this.usageSummary = s;
  }

  setContextLength(_c: number, _t?: number): void {
    /* noop */
  }
}