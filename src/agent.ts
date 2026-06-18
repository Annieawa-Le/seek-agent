import { streamText, type TextPart, type ToolCallPart, type ModelMessage, NoOutputGeneratedError } from 'ai';
import { tools } from './tools';
import { TerminalUI } from './ui';
import { TokenizerService } from './tokenizer-service';
import * as fs from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'node:path';
import { getWorkspaceRoot } from './workdir';
import { deskEditManager, DESK_EDIT_TOOLS } from './tools/desk-edit';
import { getModel, setSystemPrompt } from './model-provider';
import {
  friendlyToolCallLabel,
  friendlyToolResultLabel,
  getToolCollapse,
} from './assets/tool-translations';
import { toolCache } from './tools/tool-cache';
import { triggerListenInterceptors, triggerResultListenInterceptors, drainPendingInjections, subAgentManager } from './tools/inner_skills/sub-agent/manager';
import { extractBulk } from './tools/tool-output';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═════════════════════════════════════════════════════
// 类型定义
// ═════════════════════════════════════════════════════

/**
 * MessageHook: 在消息传递给 AI 模型之前，可以通过这个 hook 修改消息内容。
 */
export type MessageHook = (messages: ModelMessage[]) => ModelMessage[];

/**
 * PostRoundHook: 在每轮 AI 完整处理（含工具调用）结束后调用。
 */
export type PostRoundHook = (
  userInputs: string[],
  assistantText: string,
  toolCallIds: string[],
  messages: ModelMessage[],
) => void | Promise<void>;

// ═════════════════════════════════════════════════════
// CLIAAgent
// ═════════════════════════════════════════════════════

export class CLIAAgent {
  private messages: ModelMessage[] = [];
  private ui: TerminalUI;
  private modelName: string;
  private tokenizer: TokenizerService;
  private systemPrompt: string;

  /** 当前处理循环的 Promise（用作并发门控） */
  private processingPromise: Promise<void> | null = null;
  /** 用户输入队列 —— 可随时入队 */
  private inputQueue: string[] = [];
  /** 是否已中断（取消本轮及后续处理） */
  private aborted = false;
  /** 是否已完成首次交互（首次交互会清除 banner/启动提示） */
  private hasInteracted = false;
  /** 本轮实际（非缓存）工具调用计数 */
  private roundActualToolCalls = 0;
  private afterRoundCollapseQueue: Array<{ msgIndex: number; toolName: string; args: Record<string, unknown> }> = [];
  /** 上一个 single 模式工具结果（下一个工具调用时折叠渲染） */
  private lastSingleCollapse: { msgIndex: number; toolName: string; args: Record<string, unknown> } | null = null;

  messageHook: MessageHook | null = null;
  /** 每轮结束后调用的 hook */
  postRoundHook: PostRoundHook | null = null;

  constructor(ui: TerminalUI, systemPrompt?: string) {
    this.ui = ui;
    this.modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.systemPrompt = systemPrompt ?? this.loadDefaultPrompts();
    setSystemPrompt(this.systemPrompt);
    this.tokenizer = new TokenizerService();
    this.tokenizer.start().catch(() => {});
  }

  // ────────────────────────────────────────────────
  // 默认 Prompt 加载
  // ────────────────────────────────────────────────

  private loadDefaultPrompts(): string {
    const promptsDir = path.join(__dirname, 'prompts');
    const parts: string[] = [];

    const mainPath = path.join(promptsDir, 'MAIN.md');
    if (fs.existsSync(mainPath)) {
      parts.push(fs.readFileSync(mainPath, 'utf-8'));
    }

    const platform = process.platform;
    let platformFile = '';
    if (platform === 'win32') {
      platformFile = 'WINDOWS.md';
    } else if (platform === 'darwin') {
      platformFile = 'MACOS.md';
    } else if (platform === 'linux') {
      platformFile = 'LUNIX.md';
    }
    if (platformFile) {
      const platformPath = path.join(promptsDir, 'platform', platformFile);
      if (fs.existsSync(platformPath)) {
        parts.push(fs.readFileSync(platformPath, 'utf-8'));
      }
    }

    const workflowPath = path.join(promptsDir, 'WORKFLOW.md');
    if (fs.existsSync(workflowPath)) {
      parts.push(fs.readFileSync(workflowPath, 'utf-8'));
    }

    // ── 加载可用的 inner_skills 列表（仅已启用的） ──
    const skillsDir = path.join(__dirname, 'tools', 'inner_skills');
    const enabledSkillInfos: { name: string; desc: string }[] = [];
    if (fs.existsSync(skillsDir)) {
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of skillDirs) {
        const enablePath = path.join(skillsDir, dir.name, 'enable.json');
        try {
          const raw = fs.readFileSync(enablePath, 'utf-8');
          const config = JSON.parse(raw);
          if (config.enable) {
            enabledSkillInfos.push({ name: dir.name, desc: config.description || '' });
          }
        } catch {
          // 无 enable.json 或解析失败，跳过
        }
      }
    }
    if (enabledSkillInfos.length > 0) {
      const skillLines = enabledSkillInfos.map(s => `- ${s.name}${s.desc ? ': ' + s.desc : ''}`);
      parts.push('# 可用技能\n\n' + skillLines.join('\n'));
    }

    // ── 技能提示词注入（SYSTEM_INJECTION.md） ──
    const injectionParts: string[] = [];
    for (const info of enabledSkillInfos) {
      const injectionPath = path.join(skillsDir, info.name, 'SYSTEM_INJECTION.md');
      if (fs.existsSync(injectionPath)) {
        try {
          const content = fs.readFileSync(injectionPath, 'utf-8').trim();
          if (content) {
            injectionParts.push(content);
          }
        } catch {
          // 读取失败则静默跳过
        }
      }
    }
    if (injectionParts.length > 0) {
      parts.push(injectionParts.join('\n\n'));
    }

    // ── 工作区根目录下的 SEEK.md 项目指引 ──
    const seekPath = path.join(getWorkspaceRoot(), 'SEEK.md');
    if (fs.existsSync(seekPath)) {
      try {
        const seekContent = fs.readFileSync(seekPath, 'utf-8').trim();
        if (seekContent) {
          parts.push(seekContent);
        }
      } catch {
        // 读取失败则静默跳过
      }
    }

    return parts.join('\n\n');
  }

  // ────────────────────────────────────────────────
  // 公开入口
  // ────────────────────────────────────────────────

  /**
   * 提交用户输入。可随时调用 —— 即使在 AI 处理过程中。
   * 输入进入内部队列，按顺序逐个处理。
   * 返回的 Promise 在所有排队输入处理完毕后 resolve。
   */
  async run(userInput: string): Promise<void> {
    this.inputQueue.push(userInput);

    // 如果还没有处理循环在运行，启动一个
    if (!this.processingPromise) {
      this.processingPromise = this.runProcessingLoop().finally(() => {
        this.processingPromise = null;
      });
    }

    return this.processingPromise;
  }

  // ────────────────────────────────────────────────
  // 处理循环
  // ────────────────────────────────────────────────

  /**
   * 消费队列中所有待处理输入，每批输入作为一个 round 处理。
   */
  private async runProcessingLoop(): Promise<void> {
    this.aborted = false;

    while (this.inputQueue.length > 0 && !this.aborted && !this.ui.isAborted) {
      // 排空当前队列作为本轮输入
      const inputs = this.drainInputQueue();
      await this.processRound(inputs);

      // ── 触发 instructor（主模型每轮工作完成后） ──
      await this.triggerInstructorAfterRound();
    }
  }

  /** 排空输入队列，返回当前所有待处理输入 */
  private drainInputQueue(): string[] {
    const inputs = [...this.inputQueue];
    this.inputQueue = [];
    return inputs;
  }

  // ────────────────────────────────────────────────
  // 单轮处理
  // ────────────────────────────────────────────────

  /**
   * 处理一个完整轮次：
   *   用户输入 → AI 交互（可能多轮工具调用）→ 最终回复 → postRoundHook。
   *
   * 一轮中的 AI 交互期间，新来的用户输入会进入 inputQueue，
   * 不会影响当前轮的上下文完整性。
   */
  private async processRound(userInputs: string[]): Promise<void> {
    // ── 首次输入自动清除 banner 和启动提示（仅生效一次） ──
    if (!this.hasInteracted) {
      this.hasInteracted = true;
      const hasBanner = this.ui.messages.some(m => m.role === 'banner' || m.role === 'system');
      if (hasBanner) {
        this.ui.clearMessages();
        this.messages = [];
      }
    }

    // ── 阶段1：登记用户输入 ──
    for (const input of userInputs) {
      this.ui.addUserMessage(input);
      this.messages.push({ role: 'user', content: input });
    }
    this.ui.addBlankLine();

    // ── 排空子模型待注入的提交（在主模型空闲时积累的） ──
    try {
      const pending = drainPendingInjections();
      for (const p of pending) {
        this.ui.addSubAgentMessage(p.name, p.submission);
        this.messages.push({ role: 'user', content: p.submission });
      }
      if (pending.length > 0) this.ui.addBlankLine();
    } catch {
      // 排空失败不影响主流程
    }
    this.ui.setProcessing(true);
    toolCache.reset();
    this.roundActualToolCalls = 0;
    this.afterRoundCollapseQueue = [];
    this.lastSingleCollapse = null;

    const roundToolCallIds: string[] = [];
    const roundAssistantTexts: string[] = [];

    try {
      // ── 阶段2：AI 交互循环（含工具调用） ──
      await this.aiInteractionLoop(roundToolCallIds, roundAssistantTexts);
    } catch (error: any) {
      if (this.aborted || this.ui.isAborted) {
        // 中断不视为错误
      } else if (NoOutputGeneratedError.isInstance(error)) {
        this.ui.addToolMessage('■ AI 未生成输出，已终止本轮');
      } else if (error?.name === 'AbortError' || error?.message?.includes('abort')) {
        this.ui.addToolMessage('■ 已中断本轮 AI 处理');
      } else {
        this.ui.addToolMessage(`❌ 处理错误: ${error?.message || error}`);
      }
    }

    // ── 阶段3：本轮结束，调用 postRoundHook ──
    if (!this.aborted && !this.ui.isAborted && this.postRoundHook && userInputs.length > 0) {
      try {
        await this.postRoundHook(
          [...userInputs],
          roundAssistantTexts.join('\n'),
          roundToolCallIds,
          this.messages as ModelMessage[],
        );
      } catch (hookError: any) {
        this.ui.addToolMessage(`■ postRoundHook 执行出错: ${hookError.message}`);
      }
    }

    this.ui.setProcessing(false);

    // ── 自动保存会话（每轮结束）──
    if (!this.aborted && !this.ui.isAborted) {
      this.autoSaveSession();
    }
  }

  // ────────────────────────────────────────────────
  // AI 交互循环
  // ────────────────────────────────────────────────

  /**
   * 核心循环：调用 AI → 处理工具调用 → 重复直到 AI 返回纯文本回复。
   * 每轮 AI 调用前都会消费 inputQueue 中积累的新输入。
   */
  private async aiInteractionLoop(
    roundToolCallIds: string[],
    roundAssistantTexts: string[],
  ): Promise<void> {

    while (!this.aborted && !this.ui.isAborted) {
      // ── 排空子模型待注入的提交（安全网，确保 AI 总能及时看到） ──
      const safeSubmissions = drainPendingInjections();
      if (safeSubmissions.length > 0) {
        for (const p of safeSubmissions) {
          this.ui.addSubAgentMessage(p.name, p.submission);
          this.messages.push({ role: 'user', content: p.submission });
        }
        this.ui.addBlankLine();
      }
      // ── 消费 AI 处理期间积累的用户输入 ──
      if (this.inputQueue.length > 0) {
        const pendingInputs = this.drainInputQueue();
        for (const input of pendingInputs) {
          this.ui.addUserMessage(input);
          this.messages.push({ role: 'user', content: input });
        }
      }
        this.ui.addBlankLine();

      // ── 应用 messageHook ──
      let messagesForModel = this.messages;
      if (this.messageHook) {
        try {
          messagesForModel = this.messageHook(this.messages);
          this.messages = messagesForModel;
        } catch (hookError: any) {
          this.ui.addToolMessage(`■ messageHook 执行出错: ${hookError.message}，使用原消息列表继续`);
          messagesForModel = this.messages;
        }
      }

      // ── 更新上下文长度显示 ──
      this.updateContextDisplay(messagesForModel);

      // ── 调用 AI ──
      let fullText = '';
      const collectedToolCalls: any[] = [];
      let reasoningOutputs: {type: 'reasoning'; text: string}[] = [];

      try {
        const abortController = this.ui.createAbortController();
        const result = await streamText({
          model: getModel(this.modelName),
          system: this.systemPrompt,
          messages: messagesForModel,
          tools: tools,
          abortSignal: abortController.signal,
          experimental_context: { __messages: this.messages },
        });
        // ── 流式文本 ──
        this.ui.startThinkingSpinner();
        this.ui.addAgentMessage('');

        for await (const chunk of result.textStream) {
          if (this.aborted || this.ui.isAborted) break;
          fullText += chunk;
          this.ui.appendToLastAgent(chunk);
        }
        this.ui.stopThinkingSpinner();

        // 被中断，丢弃不完整回复
        if (this.aborted || this.ui.isAborted) {
          this.ui.removeLastAgent();
          break;
        }

        // ── 收集工具调用 ──
        const finalResult = await result;
        if (finalResult.toolCalls) {
          const tl = await finalResult.toolCalls;
          for (const tc of tl) {
            collectedToolCalls.push(tc);
          }
        }

        // ── 收集 reasoning（避免下一轮 deepseek 校验失败） ──
        reasoningOutputs = await result.reasoning;


        // tool 缓存策略：全部 tool-calls 保留在 assistant 消息中构建完整上下文闭环。
        // 重复调用的拦截下沉到工具层（ToolCache 类），相同参数直接返回缓存结果，
        // 不再需要在 agent 执行层做去重。模型看到完整的请求-响应闭环不会困惑。

        const hasToolCalls = collectedToolCalls.length > 0;

        // ── 安全检查：空响应 ──
        if (!fullText && !hasToolCalls) {
          this.ui.removeLastAgent();
          this.ui.addToolMessage('⚠ AI 返回为空，跳过本轮');
          break;
        }

        // ── 构建 assistant 消息（含 reasoning） ──
        const assistantContent: (TextPart | ToolCallPart | { type: 'reasoning'; text: string })[] = [];
        if (reasoningOutputs.length > 0) {
          for (const r of reasoningOutputs) {
            assistantContent.push({ type: 'reasoning', text: r.text.slice(-200) });
          }
        }
        if (fullText) {
          assistantContent.push({ type: 'text', text: fullText });
          roundAssistantTexts.push(fullText);
        }
        for (const tc of collectedToolCalls) {
          assistantContent.push({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          });
          roundToolCallIds.push(tc.toolCallId);
        }

        this.messages.push({ role: 'assistant', content: assistantContent });


        // ── 处理工具调用 ──
        if (hasToolCalls) {
          const wasInterrupted = await this.executeToolCalls(collectedToolCalls);
          if (wasInterrupted) {
            // 工具执行被 pending 输入打断 —— aiLoop 会回到顶部消费新输入
            continue;
          }
          if (this.aborted || this.ui.isAborted) break;

          this.ui.addBlankLine();
          continue; // 工具调用后有新内容，继续 AI 循环
        }

        // ── 纯文本回复 —— 本轮结束 ──
        break;

      } catch (error: any) {
        // ── 错误处理 ──
        if (this.aborted || this.ui.isAborted || error?.name === 'AbortError' || error?.message?.includes('abort')) {
          this.ui.addToolMessage('■ 已中断本轮 AI 处理');
          break;
        }
        if (NoOutputGeneratedError.isInstance(error)) {
          if (fullText) {
            const assistantContent: (TextPart | ToolCallPart | { type: 'reasoning'; text: string })[] = [];
            if (reasoningOutputs.length > 0) {
              for (const r of reasoningOutputs) {
                assistantContent.push({ type: 'reasoning', text: r.text.slice(-200) });
              }
            }
            assistantContent.push({ type: 'text', text: fullText });
            this.messages.push({ role: 'assistant', content: assistantContent });
            break;
          }
          this.ui.removeLastAgent();
          this.ui.addToolMessage('■ AI 未生成输出，已终止本轮');
          break;
        }
        this.ui.addToolMessage(`❌ 发生错误: ${error?.message || error}`);
        break;
      }
    }

    // ── 轮后折叠：折叠本轮标记为 after-round 的工具结果消息 ──
    if (this.afterRoundCollapseQueue.length > 0) {
      this.ui.collapseToolMessages(this.afterRoundCollapseQueue);
      this.afterRoundCollapseQueue = [];
    }
  }

  // ────────────────────────────────────────────────
  // 工具调用执行
  // ────────────────────────────────────────────────

  /**
   * 依次执行所有工具调用。
   * 返回 true 表示被用户新输入中断（此时消息列表已回滚，可继续 AI 循环）。
   */
  private async executeToolCalls(toolCalls: any[]): Promise<boolean> {
    let interruptedByInput = false;
    for (const toolCall of toolCalls) {
      const toolName = toolCall.toolName;
      const args = toolCall.input;

      // ── 单次折叠：下一个工具调用时折叠上一个 single 结果 ──
      if (this.lastSingleCollapse) {
        this.ui.collapseToolMessages([this.lastSingleCollapse]);
        this.lastSingleCollapse = null;
      }

      this.ui.addToolMessage(friendlyToolCallLabel(toolName, args), { toolName, args });

      // ── 检查中断或新输入 ──
      if (this.aborted || this.ui.isAborted) {
        this.ui.addToolMessage('■ 用户中断，跳过剩余工具调用');
        break;
      }
      if (this.inputQueue.length > 0) {
        interruptedByInput = true;
        break;
      }


      const toolImpl = tools[toolName as keyof typeof tools];
      if (!toolImpl?.execute) {
        this.ui.addToolMessage(`❌ 错误: 未找到工具 ${toolName}`);
        this.messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: { type: 'text', value: `错误: 未找到工具 ${toolName}` },
          }],
        });
        continue;
      }

      // ── 编辑模式拦截 ──
      if (deskEditManager.isActive()) {
        if (!DESK_EDIT_TOOLS.has(toolName)) {
          const errMsg = `⛔ 当前处于桌面编辑模式，仅支持桌面编辑工具（desk_edit, desk_add_patch, desk_del_patch, desk_modify_patch, ctrl_z, desk_save, desk_cancel）。请先调用 desk_save 退出编辑模式。`;
          this.ui.addToolMessage(errMsg);
          this.messages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: { type: 'text', value: errMsg },
            }],
          });
          continue;
        }
      }


      // ── Listen 模式自动拦截 ──
      try {
        await triggerListenInterceptors(toolName, args, this.messages);
      } catch {
        // 拦截失败不影响工具执行
      }
      // ── 执行 ──
      let execResult: unknown;
      try {
        execResult = await toolImpl.execute(args as any, {
          toolCallId: toolCall.toolCallId,
          messages: this.messages,
        });
      } catch (execError: any) {
        execResult = `执行错误: ${execError.message}`;
      }

      // ── 非缓存调用才计入实际计数 ──
      this.roundActualToolCalls += 1;
      this.ui.setToolCallCount(this.roundActualToolCalls);

      // ── 提取 rawBulk 和 AI 文本 ──
      const extracted = extractBulk(execResult);
      const sout = String(extracted.text);
      const rawBulk = extracted.rawBulk ?? undefined;

      // ── 记录轮后折叠索引（在 addToolMessage 前获取即将占用的索引） ──
      const resultMsgIdx = this.ui.messages.length;
      this.ui.addToolMessage(friendlyToolResultLabel(toolName, args, sout), void 0, sout, rawBulk);

      // ── 标记为轮后折叠 ──
      if (getToolCollapse(toolName) === 'after-round') {
        this.afterRoundCollapseQueue.push({
          msgIndex: resultMsgIdx,
          toolName,
          args,
        });
      }

      // ── 单次折叠模式：记录该结果，等下一个工具调用时折叠 ──
      if (getToolCollapse(toolName) === 'single') {
        this.lastSingleCollapse = { msgIndex: resultMsgIdx, toolName, args };
      }

      this.messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          output: { type: 'text', value: sout },
        }],
      });

      // ── Result 模式监听拦截（阻塞执行，同时显示「审查中」状态） ──
      this.ui.showListenStatus('Listen');
      try {
        await triggerResultListenInterceptors(toolName, args, sout, this.messages);
      } catch {
        // 拦截失败不影响工具结果
      }
      this.ui.hideListenStatus();
    }

    // ── 处理中断/中止（submission 留在队列中，下一轮安全时再排空） ──
    if (interruptedByInput) {
      this.rollbackPartialToolCalls();

      this.ui.addToolMessage('■ 检测到新输入，回滚未完成的工具调用，优先处理用户新指令');
      const pendingInputs = this.drainInputQueue();
      for (const input of pendingInputs) {
        this.ui.addUserMessage(input);
        this.messages.push({ role: 'user', content: input });
      }
      this.ui.addBlankLine();
      return true;
    }

    if (this.aborted || this.ui.isAborted) {
      return false;
    }

    // ── 排空子模型待注入的提交（仅在正常退出时，避免被 rollback 误删） ──
    const pendingSubmissions = drainPendingInjections();
    if (pendingSubmissions.length > 0) {
      this.ui.addBlankLine();
      for (const p of pendingSubmissions) {
        this.ui.addSubAgentMessage(p.name, p.submission);
        this.messages.push({ role: 'user', content: p.submission });
      }
      this.ui.addBlankLine();
    }

    return false;
  }

  /**
   * 回滚因 pending 输入中断而部分执行的工具调用：
   * 移除最后一条 assistant 消息（含 tool-call），
   * 及其之后添加的所有 tool-result 消息。
   */
  private rollbackPartialToolCalls(): void {
    // 从末尾向前找到第一条带 tool-call 的 assistant 消息
    let assistantIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const hasToolCall = msg.content.some((p: any) => p.type === 'tool-call');
        if (hasToolCall) {
          assistantIdx = i;
          break;
        }
      }
    }

    if (assistantIdx === -1) return;

    // 移除该 assistant 消息及之后的所有 tool 消息
    const newLen = assistantIdx;
    let i = this.messages.length - 1;
    while (i >= newLen) {
      this.messages.pop();
      i--;
    }
  }

  // ────────────────────────────────────────────────

  // ────────────────────────────────────────────────
  // Instructor 触发
  // ────────────────────────────────────────────────

  /**
   * 每轮主模型工作完成后，触发所有 instructor 发散思维提出建议。
   * 如果本轮处理的是真实用户输入（非 instructor 自产的消息），重置轮次计数。
   * 如果用户在此过程中终止，已中断的轮次不会触发 instructor。
   */
  private async triggerInstructorAfterRound(): Promise<void> {
    // ── 如果本轮被中止或中断，不触发 instructor ──
    if (this.aborted || this.ui.isAborted) return;

    const instructors = subAgentManager.getAllInstructors();
    if (instructors.length === 0) return;

    for (const instructor of instructors) {
      if (this.aborted || this.ui.isAborted) return;

      // 检查最后一条用户消息：如果是真实用户输入，重置计数
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.role === 'user' && typeof m.content === 'string') {
          if (!/^【.* 建议】/.test(m.content)) {
            instructor.instructorRoundCount = 0;
          }
          break;
        }
      }

      // 检查是否达到最大轮次
      const maxRounds = instructor.maxRounds ?? 3;
      if ((instructor.instructorRoundCount ?? 0) >= maxRounds) continue;

      // 获取主模型最后输出的文本
      let lastOutput = '';
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.role === 'assistant') {
          if (typeof m.content === 'string') {
            lastOutput = m.content;
            break;
          }
          if (Array.isArray(m.content)) {
            for (const p of m.content) {
              if (typeof p === 'object' && 'type' in p && p.type === 'text') {
                lastOutput = (p as any).text;
                break;
              }
            }
            if (lastOutput) break;
          }
        }
      }
      if (!lastOutput.trim()) continue;

      try {
        const { executeInstructorAgent } = await import('./tools/inner_skills/sub-agent/runner');
        const result = await executeInstructorAgent(instructor, lastOutput);

        // instructor 运行过程中用户可能中断了
        if (this.aborted || this.ui.isAborted) return;

        if (result && result.trim()) {
          const msg = `【${instructor.name} 建议】\n${result}`;
          this.ui.addSubAgentMessage(instructor.name, msg);
          this.inputQueue.push(msg);
          this.ui.addBlankLine();
          this.ui.addToolMessage(`■ 收到 ${instructor.name} 的建议，继续下一轮处理`);
        }
      } catch {
        // instructor 执行失败不影响主流程
      }
    }
  }

  // ────────────────────────────────────────────────
  // 上下文长度显示
  // ────────────────────────────────────────────────

  private updateContextDisplay(messagesForModel: ModelMessage[]): void {
    const sysLen = this.systemPrompt.length;
    const msgLen = messagesForModel.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + m.content.length;
      if (Array.isArray(m.content)) {
        return sum + (m.content as any[]).reduce((s, p) => {
          if (typeof p === 'string') return s + p.length;
          if (p.text) return s + p.text.length;
          if (p.type === 'tool-call') return s + JSON.stringify(p.input).length;
          if (p.type === 'tool-result') {
            const output = p.output;
            if (typeof output === 'string') return s + output.length;
            if (output?.value) return s + String(output.value).length;
            return s + JSON.stringify(output).length;
          }
          return s;
        }, 0);
      }
      return sum;
    }, 0);

    const charTotal = sysLen + msgLen;
    this.ui.setContextLength(charTotal);

    // 异步 tokenizer 估算（不阻塞）
    const textForTokenize = this.systemPrompt + '\n' +
      messagesForModel.map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return (m.content as any[]).map(p => {
            if (typeof p === 'string') return p;
            if (p.text) return p.text;
            if (p.type === 'tool-call') return JSON.stringify(p.input);
            if (p.type === 'tool-result') {
              const out = p.output;
              if (typeof out === 'string') return out;
              if (out?.value) return String(out.value);
              return JSON.stringify(out);
            }
            return '';
          }).join(' ');
        }
        return '';
      }).join('\n');

    this.tokenizer.countTokens(textForTokenize)
      .then(tokens => {
        this.ui.setContextLength(charTotal, tokens);
      })
      .catch(() => {});
  }

  // ────────────────────────────────────────────────
  // 清除
  // ────────────────────────────────────────────────

  clear(): void {
    this.messages = [];
    this.inputQueue = [];
    this.ui.clearMessages();
  }

  // ────────────────────────────────────────────────
  // 会话存取支持
  // ────────────────────────────────────────────────

  /** 获取当前所有消息（用于保存会话） */
  getMessages(): ModelMessage[] {
    return this.messages;
  }

  /** 设置消息列表（用于恢复会话） */
  setMessages(msgs: ModelMessage[]): void {
    this.messages = msgs;
  }

  // ────────────────────────────────────────────────
  // 自动保存
  // ────────────────────────────────────────────────

  /**
   * 每轮结束后自动保存当前会话到 sessions/ 目录
   * 使用时间戳文件名，不覆盖已有会话
   */
  private autoSaveSession(): void {
    const messages = this.messages;
    if (messages.length === 0) return;

    const sessionDir = path.join(getWorkspaceRoot(), 'sessions');
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `session-${ts}.json`;
    const filePath = path.join(sessionDir, fileName);

    const data = {
      version: 1,
      timestamp: now.toISOString(),
      cwd: process.cwd(),
      agentMessages: messages,
    };

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // 自动保存失败不影响主流程
    }
  }
}




























































