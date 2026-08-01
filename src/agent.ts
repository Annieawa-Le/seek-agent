import { getMcpManager } from './mcp';
import { streamText, type TextPart, type ToolCallPart, type ModelMessage, NoOutputGeneratedError } from 'ai';
import { tools, stripToolExecutes } from './tools';
import { checkToolGate, getActiveModes, getActiveModeNames } from './modes/registry';
import { drainPendingInjections, hasPendingInjections, subAgentManager, setSubmissionListener } from './tools/inner_skills/sub-agent/manager';
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
import { summarizeSessionTitle, fallbackTitle, sanitizeTitle } from './tools/session-title';
import { extractBulk } from './tools/tool-output';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 内部触发标记：子模型提交后空闲时触发新一轮（不显示为 user 消息） */
const INTERNAL_SUBMISSION_TRIGGER = '__internal_submission__';

// 类型定义
// ═════════════════════════════════════════════════════

/**
 * MessageHook: 在消息传递给 AI 模型之前，可以通过这个 hook 修改消息内容。
 */
export type MessageHook = (messages: ModelMessage[]) => ModelMessage[] | Promise<ModelMessage[]>;

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

  /** 当前会话唯一标识，用于会话文件命名 */
  private sessionId: string;
  /** 会话标题（由轻量模型总结，用于 session 文件名） */
  private sessionTitle = '';
  /** 当前实际保存的 session 文件名（用于标题变化时清理旧文件） */
  private savedSessionFileName = '';
  /** 上次刷新标题的时间戳（节流用） */
  private lastTitleRefreshAt = 0;
  /** 上次刷新标题时的用户消息数（用于检测对话是否有实质进展） */
  private lastTitleRefreshMsgCount = 0;

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
  /** 智能搜索模式开关 */
  private smartSearchEnabled = false;
  /** 思考模式开关 */
  private thinkingEnabled = false;
  private lastSingleCollapse: { msgIndex: number; toolName: string; args: Record<string, unknown> } | null = null;

  messageHook: MessageHook | null = null;
  /** 每轮结束后调用的 hook */
  postRoundHook: PostRoundHook | null = null;

  constructor(ui: TerminalUI, systemPrompt?: string) {
    this.sessionId = this.generateSessionId();
    this.ui = ui;
    this.modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.systemPrompt = this.withModePrompts(systemPrompt ?? this.loadDefaultPrompts());
    setSystemPrompt(this.systemPrompt);
    this.tokenizer = new TokenizerService();
    this.tokenizer.start().catch(() => {});

    // 子模型提交监听：入队后注入 tool 消息对（空闲时触发新一轮）
    setSubmissionListener(() => { this.onSubAgentSubmission().catch(() => {}); });


    // 注册进程退出时的 MCP 清理
    const cleanup = () => {
      import('./mcp').then(({ shutdownMCP }) => shutdownMCP()).catch(() => {});
    };
    process.on('beforeExit', cleanup);
  }

  /**
   * 重新加载 system prompt（切换工作目录后调用，刷新 SEEK.md）
   */
  reloadPrompt(): void {
    this.systemPrompt = this.withModePrompts(this.loadDefaultPrompts(this.smartSearchEnabled));
    setSystemPrompt(this.systemPrompt);
  }

  /** 拼接激活模式的 promptAddon（多模式按激活顺序追加） */
  private withModePrompts(base: string): string {
    const parts = getActiveModes().map((m) => m.promptAddon).filter(Boolean) as string[];
    return parts.length > 0 ? `${base}\n\n${parts.join('\n\n')}` : base;
  }

  /** 启用/禁用智能搜索模式 */
  setSmartSearch(enabled: boolean): void {
    this.smartSearchEnabled = enabled;
    this.reloadPrompt();
  }

  /** 启用/禁用思考模式 */
  setThinking(enabled: boolean): void {
    this.thinkingEnabled = enabled;
    this.reloadPrompt();
  }

  /**
   * 构建会话开场指令（随思考模式注入，仅每轮第一次 AI 调用时生效）。
   * 包含：思考模式要求 + 工作流程要点 + 可用工具列表 + 记忆系统提醒。
   */
  private static buildSessionInstruction(): string {
    // 核心工具分组（精确列出，随 tools 容器动态校验存在性）
    const coreGroups: [string, string[]][] = [
      ['文件', ['read_file', 'read_lines', 'read_num_line', 'scan_file', 'create_file', 'replace_file', 'add_patch', 'del_patch', 'undo_patch', 'history_patch']],
      ['搜索/执行', ['search_all_file', 'search_sub_file', 'search_directory', 'search_content', 'execute_command']],
      ['任务', ['create_todo', 'finish_step', 'undo_step', 'reroll_step', 'del_step', 'read_todo', 'del_todo', 'active_todo']],
      ['记忆', ['memory_add', 'memory_update', 'memory_touch', 'memory_remove', 'memory_list', 'memory_remember', 'memory_recall', 'memory_stats', 'memory_clear']],
      ['桌面/上下文', ['desk_add', 'desk_list', 'desk_remove', 'desk_clear', 'memory_focus', 'memory_shorten']],
    ];
    const known = new Set(coreGroups.flatMap(([, t]) => t));
    const groupLines = coreGroups
      .map(([label, t]) => `  ${label}: ${t.filter((n) => n in tools).join(', ')}`)
      .filter((l) => l.trim().length > 0);

    // 技能工具按前缀聚合（数量统计）
    const skillGroups: [RegExp, string][] = [
      [/^gh_/, 'GitHub'],
      [/^docx_|^pdf_|^pptx_|^xlsx_|^run_page/, 'Office/文档'],
      [/^ui_|^generate_|^analyze_/, 'UI/前端'],
      [/^image_|^extract_|^download_|^vision_/, '图片'],
      [/^kb_/, '知识库'],
      [/^spawn_agent|^agent_|^a_submission/, '子模型'],
      [/^tavily_|^search_web|^fetch_page|^crawl_|^extract_links/, '联网'],
      [/^explorer-|^list_directory|^enter_subfolder|^go_up/, '目录浏览'],
      [/^scanning_|^read_function|^read_class|^read_package|^jump_to_definition|^get_function_range|^find_matching_brace|^wrap_by/, '代码分析'],
      [/^create_skill|^list_skills|^reload_skills|^remove_skill|^remove_tool/, '技能管理'],
      [/^todo_save|^todo_load|^todo_list_saved|^todo_delete_saved/, '任务持久化'],
      [/^search_icons|^get_icon_detail|^list_all_icons/, '图标'],
    ];
    const counts = new Map<string, number>();
    for (const name of Object.keys(tools)) {
      if (known.has(name)) continue;
      const hit = skillGroups.find(([re]) => re.test(name));
      const label = hit ? hit[1] : '其他';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const skillLine = [...counts.entries()]
      .filter(([, c]) => c > 0)
      .map(([label, c]) => `${label}${c > 1 ? `(${c})` : ''}`)
      .join('、');

    return [
      '当前处于【思考模式】。在回答任何问题之前，你必须先在 <thinking> 标签内完整展开推理过程（选择合适的工具，分步分析问题、评估可能的方案、检查潜在错误），然后再给出最终答案。思考内容写在 <thinking>...</thinking> 中，最终答案在标签外输出。禁止在最终答案中重复思考过程。',
      '',
      '工作流程：先理解后修改，先计划后执行，每步可回溯。接到任务先阅读相关代码，多步任务用 create_todo 跟踪进度，每轮修改后编译验证。',
      '',
      `可用工具（核心）：`,
      ...groupLines,
      skillLine ? `  技能工具：${skillLine}（完整定义见各工具 schema）` : '',
      '',
      '记忆系统：每轮自动注入 [工作记忆]（当前焦点），可用 memory_add/update/touch/remove 维护；跨会话规则与约定用 memory_remember 沉淀，新任务开始前先用 memory_recall 检索相关历史约定。',
    ].join('\n');
  }

  // ────────────────────────────────────────────────
  // 默认 Prompt 加载
  // ────────────────────────────────────────────────

  private loadDefaultPrompts(smartSearch = false): string {
    const promptsDir = path.join(__dirname, 'prompts');
    const parts: string[] = [];

    // 主提示词：角色模式（manager/worker 等）用 mainReplacement 替换 MAIN.md，其余模式用默认 MAIN.md
    const mainReplacement = getActiveModes().map((m) => m.mainReplacement).find(Boolean);
    if (mainReplacement) {
      parts.push(mainReplacement);
    } else {
      const mainPath = path.join(promptsDir, 'MAIN.md');
      if (fs.existsSync(mainPath)) {
        parts.push(fs.readFileSync(mainPath, 'utf-8'));
      }
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


    // ── 当前工作目录 ──
    parts.push(`> 当前工作目录：${getWorkspaceRoot()}`);

    // ── MCP Server 指令注入 ──
    const mcpManager = getMcpManager();
    const mcpInstructions = mcpManager?.getAllInstructions() ?? [];
    if (mcpInstructions.length > 0) {
      parts.push(`## 已连接的 MCP Server 使用说明\n${mcpInstructions.join('\n\n')}`);
    }

    // ── 智能搜索模式：禁用普通搜索，仅使用 tavily ──
    if (smartSearch) {
      parts.push("当前处于【智能搜索】模式。在此模式下，你应当优先并使用 tavily_search / tavily_extract / tavily_crawl / tavily_map / tavily_research 等 Tavily 工具获取外部信息。不要使用 search_web、fetch_page、crawl_site、extract_links 等普通搜索/爬取工具。");
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

      // ── 兜底：若本轮收尾期间有子模型提交入队（onSubAgentSubmission 因
      // processingPromise 非空未触发 run），继续下一轮让主模型看到 ──
      if (hasPendingInjections() && !this.aborted && !this.ui.isAborted) {
        this.inputQueue.push(INTERNAL_SUBMISSION_TRIGGER);
      }
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

    // ── 阶段1：登记用户输入（内部触发标记不添加 user 气泡，仅驱动新一轮） ──
    for (const input of userInputs) {
      if (input === INTERNAL_SUBMISSION_TRIGGER) continue;
      this.ui.addUserMessage(input);
      this.messages.push({ role: 'user', content: input });
    }
    this.ui.addBlankLine();

    // ── 排空子模型待注入的提交（以 tool 消息对注入，不插入 user 气泡） ──
    try {
      this.injectSubmissionsToMessages();
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

    // ── 若还有待注入的子模型提交，驱动新一轮让主模型看到（安全点统一注入） ──
    if (hasPendingInjections() && !this.aborted && !this.ui.isAborted) {
      this.inputQueue.push(INTERNAL_SUBMISSION_TRIGGER);
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
    // 思考模式：仅本轮第一次模型调用（处理用户输入后）主动触发思考，工具循环中间的调用不思考
    let isFirstModelCall = true;

    while (!this.aborted && !this.ui.isAborted) {
      // ── 排空子模型待注入的提交（安全网，以 tool 消息对注入） ──
      try {
        this.injectSubmissionsToMessages();
      } catch { /* 排空失败不影响 */ }

      // ── 消费 AI 处理期间积累的用户输入 ──
      if (this.inputQueue.length > 0) {
        const pendingInputs = this.drainInputQueue();
        for (const input of pendingInputs) {
          this.ui.addUserMessage(input);
          this.messages.push({ role: 'user', content: input });
        }
      }

      // ── 应用 messageHook ──
      let messagesForModel = this.messages;
      if (this.messageHook) {
        try {
          messagesForModel = await this.messageHook(this.messages);
          this.messages = messagesForModel;
        } catch (hookError: any) {
          this.ui.addToolMessage(`■ messageHook 执行出错: ${hookError.message}，使用原消息列表继续`);
          messagesForModel = this.messages;
        }
      }

      // ── 更新上下文长度显示 ──
      this.updateContextDisplay(messagesForModel);
      // ── 调用 AI ──
      // 思考模式：仅第一次调用主动触发（注入思考参数与指令），中间轮次不提交思考
      const thinkingThisCall = isFirstModelCall && this.thinkingEnabled;
      let fullText = '';
      const collectedToolCalls: any[] = [];
      let reasoningOutputs: {type: 'reasoning'; text: string}[] = [];
      // 思考模式：流式思考内容 + <thinking> 标签剥离缓冲
      let thinkingDeltaBuf = '';
      let thinkingText = '';
      let inThinkingTag = false;
      // 本轮是否走原生 reasoning 流（区分标签式思考：<thinking> 文本也走 text-delta）
      let nativeReasoning = false;

      /** 将模型输出文本喂入正文/思考流，自动识别 <thinking> 标签 */
      const feedText = (text: string) => {
        if (!thinkingThisCall) {
          fullText += text;
          this.ui.appendToLastAgent(text);
          return;
        }
        for (const ch of text) {
          thinkingDeltaBuf += ch;
          if (thinkingDeltaBuf.endsWith('<thinking>')) {
            // 标签前的正文残留（未达 flush 阈值）先补进正文流，避免丢失；
            // 注意 fullText 已在批量 flush 时同步展示过，不能整体再追加（会重复显示）
            const pre = thinkingDeltaBuf.slice(0, -'<thinking>'.length);
            if (pre) {
              fullText += pre;
              this.ui.appendToLastAgent(pre);
            }
            inThinkingTag = true;
            this.ui.startThinking();
            thinkingDeltaBuf = '';
            continue;
          }
          if (thinkingDeltaBuf.endsWith('</thinking>')) {
            const thought = thinkingDeltaBuf.slice(0, -'</thinking>'.length);
            thinkingText += thought;
            this.ui.feedThinking(thought);
            this.ui.endThinking();
            inThinkingTag = false;
            thinkingDeltaBuf = '';
            continue;
          }
          if (thinkingDeltaBuf.length > '<thinking>'.length) {
            if (inThinkingTag) {
              thinkingText += thinkingDeltaBuf;
              this.ui.feedThinking(thinkingDeltaBuf);
            } else {
              fullText += thinkingDeltaBuf;
              this.ui.appendToLastAgent(thinkingDeltaBuf);
            }
            thinkingDeltaBuf = '';
          }
        }
      };
      try {
        const abortController = this.ui.createAbortController();
        const result = await streamText({
          model: getModel(this.modelName),
          // 思考指令仅在本轮第一次调用时注入，工具循环中间使用纯净 system prompt
          system: thinkingThisCall
            ? `${this.systemPrompt}\n\n${CLIAAgent.buildSessionInstruction()}`
            : this.systemPrompt,
          messages: messagesForModel,
          tools: stripToolExecutes(tools), // 剥离 execute，避免 AI SDK 内部自动执行工具导致双重执行
          abortSignal: abortController.signal,
          experimental_context: { __messages: this.messages },
          // 思考模式：向模型透传思考相关参数（按 provider 生效）
          ...(thinkingThisCall ? {
            providerOptions: {
              deepseek: { thinking: { type: 'enabled' } },
              opencode: { reasoningEffort: 'high' },
            },
          } : {}),
          // 原生思考流（如 deepseek-reasoner 类模型）：实时收集 reasoning 展示
          onChunk: ({ chunk }) => {
            if (chunk.type === 'reasoning-delta') {
              nativeReasoning = true;
              thinkingText += chunk.text;
              // 思考模式开启时展示思考流（无论第几次调用）。
              // 工具循环中模型返回的 reasoning 同样渲染为独立思考气泡，
              // 文本始终收集进上下文（assistantContent 的 reasoning part）。
              if (this.thinkingEnabled) {
                if (!this.ui.isThinkingActive()) this.ui.startThinking();
                this.ui.feedThinking(chunk.text);
              }
            }
            if (chunk.type === 'text-delta') {
              // 原生 reasoning 流必然先于正文流结束：正文 delta 到达即结束思考气泡，
              // 否则气泡残留 streaming 会把下一轮的思考合并进上一轮。
              // 标签式思考（<thinking> 文本）同样走 text-delta，但思考气泡由 feedText
              // 的 </thinking> 分支负责结束，因此这里仅处理原生路径（nativeReasoning），
              // 且不复位 thinkingDeltaBuf / inThinkingTag（会破坏跨 chunk 标签匹配）。
              if (nativeReasoning && this.ui.isThinkingActive()) {
                this.ui.endThinking();
              }
            }
          },
        });
        // 首次模型调用已发生，后续工具循环中的调用不再主动触发思考
        isFirstModelCall = false;
        // ── 流式文本 ──
        // 原生 reasoning 流必然先于文本流结束：先复位思考区，
        // 确保正文进入独立的普通文本气泡，而不是被并进思考气泡
        if (this.ui.isThinkingActive()) {
          this.ui.endThinking();
        }
        thinkingDeltaBuf = '';
        this.ui.startThinkingSpinner();
        this.ui.addAgentMessage('');
        for await (const chunk of result.textStream) {
          if (this.aborted || this.ui.isAborted) break;
          feedText(chunk);
        }
        this.ui.stopThinkingSpinner();
        // ── 思考流收尾：flush 残留缓冲 ──
        // feedText 以 '<thinking>'.length 为阈值批量 flush，textStream 结束后
        // 缓冲里可能残留不足一个阈值的正文（短回复 / 末块尾巴），必须在此收口，
        // 否则短正文会整体丢失、长正文结尾被截断。
        if (thinkingDeltaBuf) {
          if (inThinkingTag) {
            // <thinking> 未闭合：残留内容属于思考流
            thinkingText += thinkingDeltaBuf;
            this.ui.feedThinking(thinkingDeltaBuf);
          } else {
            // 正常正文残留：补进正文流（UI + 上下文）
            fullText += thinkingDeltaBuf;
            this.ui.appendToLastAgent(thinkingDeltaBuf);
          }
          thinkingDeltaBuf = '';
        }
        inThinkingTag = false;
        if (this.ui.isThinkingActive()) {
          this.ui.endThinking();
        }


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
            assistantContent.push({ type: 'reasoning', text: r.text });
          }
        } else if (thinkingText) {
          // <thinking> 标签剥离的思考内容，作为 reasoning part 进入上下文（完整保留，供会话记录）
          assistantContent.push({ type: 'reasoning', text: thinkingText });
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
                assistantContent.push({ type: 'reasoning', text: r.text });
              }
            } else if (thinkingText) {
              assistantContent.push({ type: 'reasoning', text: thinkingText });
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
      // TODO：此处没做三端分离
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

      // ── 模式工具门（白名单/黑名单拦截） ──
      const gate = checkToolGate(toolName);
      if (!gate.allowed) {
        const errMsg = gate.reason ?? `⛔ 当前模式禁止调用工具 ${toolName}`;
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


      // ── 执行 ──
      let execResult: unknown;
      try {
        execResult = await toolImpl.execute(args as any, {
          toolCallId: toolCall.toolCallId,
          messages: this.messages,
          ui: this.ui,
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

    // ── 排空子模型待注入的提交（仅在正常退出时，避免被 rollback 误删；以 tool 消息对注入） ──
    try {
      this.injectSubmissionsToMessages();
    } catch { /* 排空失败不影响 */ }

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
  // 子模型提交注入（以工具调用形式，不插入 user 气泡）
  // ────────────────────────────────────────────────

  /**
   * 排空子模型待注入的提交，构造 assistant tool-call + tool tool-result 消息对
   * 插入主对话，并在 UI 中以工具调用/结果块显示（替代原 addSubAgentMessage 的 user 气泡）。
   * @returns 注入的提交数
   */
  private injectSubmissionsToMessages(): number {
    const pending = drainPendingInjections();
    if (pending.length === 0) return 0;
    for (const p of pending) {
      const args = { name: p.name, summary: p.payload.summary, details: p.payload.details };
      // UI：工具调用 + 结果块（保持视觉一致）
      this.ui.addToolMessage(friendlyToolCallLabel('subagent_submission', args), { toolName: 'subagent_submission', args });
      const resultText = `【${p.name} 提交工作结果】\n概要: ${p.payload.summary}\n详情: ${p.payload.details}`;
      this.ui.addToolMessage(friendlyToolResultLabel('subagent_submission', args, resultText), void 0, resultText);
      // messages：以 user 消息注入（不能构造 tool-call/tool-result 对——
      // 上游 Console Go 校验 tool_call_id 必须为自己生成，伪造 id 会被 400 拒绝）
      this.messages.push({ role: 'user', content: resultText });
    }
    return pending.length;
  }

  /**
  /**
   * 子模型提交监听（subAgentManager 入队后调用）。
   * 只负责在空闲时触发新一轮处理；消息对由安全点统一注入
   * （processRound 开头 / aiInteractionLoop 顶部 / executeToolCalls 末尾），
   * 避免插入时机落在工具结果落盘之前导致 tool-result 与 assistant tool-call 乱序
   * （上游会以 400 invalid_request_error 拒绝）。
   */
  async onSubAgentSubmission(): Promise<void> {
    if (!this.processingPromise) {
      await this.run(INTERNAL_SUBMISSION_TRIGGER);
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
    this.sessionTitle = '';
    this.savedSessionFileName = '';
    this.sessionId = this.generateSessionId();
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
   * 每轮结束后自动保存当前会话到 sessions/ 目录。
   * 文件名使用轻量模型总结的会话标题：session-{标题}.json；
   * 标题未生成前回退到首条用户输入；标题变化时清理旧文件。
   */
  private autoSaveSession(): void {
    const messages = this.messages;
    if (messages.length === 0) return;

    const sessionDir = path.join(getWorkspaceRoot(), 'sessions');
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const title = this.sessionTitle || fallbackTitle(messages);
    const fileName = `session-${sanitizeTitle(title)}.json`;
    const filePath = path.join(sessionDir, fileName);

    // 标题变化：清理旧文件，避免同一会话产生多个文件
    if (this.savedSessionFileName && this.savedSessionFileName !== fileName) {
      try {
        fs.unlinkSync(path.join(sessionDir, this.savedSessionFileName));
      } catch {
        // 旧文件不存在则忽略
      }
    }

    const data = {
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      title: this.sessionTitle,
      cwd: process.cwd(),
      mode: getActiveModeNames(), // 模式随会话持久化（切回时恢复）
      agentMessages: messages,
    };

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.savedSessionFileName = fileName;
    } catch {
      // 自动保存失败不影响主流程
    }
  }

  /**
   * 用轻量模型刷新会话标题（后台调用）。
   * 节流：标题为空（首次）总是刷新；否则需满足 30 秒间隔 + 新增 ≥2 条用户消息。
   */
  async refreshSessionTitle(): Promise<string> {
    const now = Date.now();
    const isFirst = !this.sessionTitle;
    const enoughGap = now - this.lastTitleRefreshAt >= 30_000;
    const newMessages =
      this.countUserInputs() - this.lastTitleRefreshMsgCount >= 2;

    if (!isFirst && (!enoughGap || !newMessages)) {
      return this.sessionTitle;
    }
    this.lastTitleRefreshAt = now;
    this.lastTitleRefreshMsgCount = this.countUserInputs();
    const title = await summarizeSessionTitle(this.messages);
    if (title && title !== this.sessionTitle) {
      this.sessionTitle = title;
      // 立即用新标题重存（旧文件由 autoSaveSession 清理）
      this.autoSaveSession();
    }
    return this.sessionTitle;
  }

  /** 统计真实用户输入条数（排除系统注入的 [工作记忆] 与子模型提交） */
  private countUserInputs(): number {
    return this.messages.filter(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        !m.content.startsWith('[工作记忆]') &&
        !m.content.startsWith('【') &&
        !m.content.startsWith('[知识库检索]'),
    ).length;
  }

  /** 设置会话标题（用于从文件恢复会话时指定） */
  setSessionTitle(title: string): void {
    if (title) this.sessionTitle = title;
  }

  /** 获取当前会话标题 */
  getSessionTitle(): string {
    return this.sessionTitle;
  }

  /** 生成新的会话 ID */
  private generateSessionId(): string {
    const rand = () => Math.random().toString(36).substring(2, 6);
    return `${rand()}-${rand()}-${rand()}`;
  }

  /** 设置会话 ID（用于从文件恢复会话时指定） */
  setSessionId(id: string): void {
    this.sessionId = id;
  }
}


























































































