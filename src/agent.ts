import { getMcpManager } from './mcp';
import { streamText, type TextPart, type ToolCallPart, type ModelMessage, NoOutputGeneratedError } from 'ai';
import { tools, stripToolExecutes, resolveLazyTool, sanitizeToolInput, unwrapToolArgs } from './tools';
import { checkToolGate, getActiveModes, getActiveModeNames, filterToolsForActiveModes } from './modes/registry';
import { drainPendingInjections, hasPendingInjections, subAgentManager, setSubmissionListener } from './tools/inner_skills/sub-agent/manager';
import type { SubAgentState } from './tools/inner_skills/sub-agent/types';
import { TerminalUI } from './ui';
import { TokenizerService } from './tokenizer-service';
import * as fs from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'node:path';
import { getWorkspaceRoot, getWorkspaceRoots, getSessionsRoot, resolvePath } from './workdir';
import { deskEditManager, DESK_EDIT_TOOLS } from './tools/desk-edit';
import { setAlarmListener } from './tools/alarm';
import { getModel, setSystemPrompt } from './model-provider';
import {
  friendlyToolCallLabel,
  friendlyToolResultLabel,
  getToolCollapse,
} from './assets/tool-translations';
import { toolCache } from './tools/tool-cache';
import { patchBatch, PATCH_TOOL_NAMES } from './tools/patch-batch';
import { readFileLines } from './tools/file-manipulation';
import { summarizeSessionTitle } from './tools/session-title';
import { extractBulk } from './tools/tool-output';
import { IllusionAgent } from './illusion_agent';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 内部触发标记：子模型提交后空闲时触发新一轮（不显示为 user 消息） */
const INTERNAL_SUBMISSION_TRIGGER = '__internal_submission__';

/** 把 provider 上报的 token 数值规整为非负整数（非法值视为 undefined） */
function normalizeToken(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.round(v);
}

import { compactMessages, checkBudget, estimateMessagesTokens, slimOldestRound, type CompactionPlan } from './context-compactor';
import { worklogStore } from './tools/worklog-store';
import { subagentContextStore } from './tools/subagent-context-store';
import { subagentRegistryStore } from './tools/subagent-registry-store';
import { docPoolStore } from './tools/doc-pool-store';
import { maybeDistillActions } from './tools/action-memory';
// 类型定义
// ═════════════════════════════════════════════════════

/**
 * MessageHook: 在消息传递给 AI 模型之前，可以通过这个 hook 修改消息内容。
 */
export type MessageHook = (messages: ModelMessage[]) => ModelMessage[] | Promise<ModelMessage[]>;

/**
 * 一次发给模型的完整 payload 记录（session 附加字段，供 WebUI「记忆」面板展示）。
 * system 为实际注入的系统提示词（含模式/思考指令拼接），
 * tools 为剥离 execute 后的工具 schema（模型可见定义），
 * messages 为发送时的完整消息列表。
 */
export interface PayloadRecord {
  ts: string;
  /** 本次调用是否注入了思考指令（thinkingThisCall） */
  thinking: boolean;
  system: string;
  messages: ModelMessage[];
  tools: Record<string, any>;
}

/** payload 历史上限：避免 session 文件因完整工具 schema 重复存储而过度膨胀 */
const MAX_PAYLOAD_HISTORY = 8;
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
  /** 每次发给模型的完整 payload 历史（最近 MAX_PAYLOAD_HISTORY 条，随 session 落盘） */
  private payloadHistory: PayloadRecord[] = [];

  /** 当前会话唯一标识，用于会话文件命名 */
  private sessionId: string;
  /** 会话标题（由轻量模型总结，用于展示；落盘位置固定为 sessionId 文件夹） */
  private sessionTitle = '';
  /** 上次刷新标题的时间戳（节流用） */
  private lastTitleRefreshAt = 0;
  /** 上次刷新标题时的用户消息数（用于检测对话是否有实质进展） */
  private lastTitleRefreshMsgCount = 0;

  /** 当前处理循环的 Promise（用作并发门控） */
  private processingPromise: Promise<void> | null = null;
  /** 用户输入队列 —— 可随时入队 */
  private inputQueue: string[] = [];
  /** 闹钟待注入消息（处理中时暂存，安全点注入；不进 inputQueue，避免被当作新输入打断工具调用） */
  private pendingAlarmMessages: string[] = [];
  /** 上下文压缩：待应用的压缩计划（下一轮输入的安全点应用） */
  private pendingCompaction: CompactionPlan | null = null;
  /** 上下文压缩：压缩任务是否在飞（防重入，一轮最多一次） */
  private compactionInFlight = false;
  private aborted = false;
  /** 是否已完成首次交互（首次交互会清除 banner/启动提示） */
  private hasInteracted = false;
  /** 本轮实际（非缓存）工具调用计数 */
  private roundActualToolCalls = 0;
  /** 会话累计 token 用量四桶（dsh 风格：uncachedInput + output + cacheRead + cacheWrite，互斥不重复） */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private afterRoundCollapseQueue: Array<{ msgIndex: number; toolName: string; args: Record<string, unknown> }> = [];
  /** 智能搜索模式开关 */
  private smartSearchEnabled = false;
  /** 思考模式开关 */
  private thinkingEnabled = false;
  /** 「100% AI」幻觉模式专用循环（懒创建，仅 hallucination 模式激活时使用） */
  private illusionAgent: IllusionAgent | null = null;
  private lastSingleCollapse: { msgIndex: number; toolName: string; args: Record<string, unknown> } | null = null;
  /** Prompt 本地化：开启后不再自动注入动态组装的 system/tools，复用最近一次 payload 快照 */
  private promptLocalizationEnabled = false;

  messageHook: MessageHook | null = null;
  /** 每轮结束后调用的 hook */
  postRoundHook: PostRoundHook | null = null;

  constructor(ui: TerminalUI, systemPrompt?: string) {
    // Electron 多会话模式下与主进程身份对齐（渲染层/主进程按此 ID 关联会话与自动保存文件）；
    // TUI 单会话模式无 AGENT_SESSION_ID，退化为随机生成。
    this.sessionId = process.env.AGENT_SESSION_ID || this.generateSessionId();
    // 归档存储绑定当前会话（记忆消退路径的 worklog_recall / work_recall 按会话分区）
    worklogStore.setSessionId(this.sessionId);
    // 子 Agent 上下文本地化存储同样按会话分区
    // 子 Agent 上下文本地化存储同样按会话分区
    subagentContextStore.setSessionId(this.sessionId);
    // 子 Agent 注册状态存储按会话分区
    subagentRegistryStore.setSessionId(this.sessionId);
    // 文件池（doc_pool）落盘位置跟随会话
    docPoolStore.setSessionId(this.sessionId);
    this.ui = ui;
    this.modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.systemPrompt = this.withModePrompts(systemPrompt ?? this.loadDefaultPrompts());
    setSystemPrompt(this.systemPrompt);
    // Prompt 本地化（PROMPT_LOCALIZATION=true）：会话固定复用最近一次 payload 快照（system+工具），
    // 不再随技能启停/工作区切换/文件变化自动重组系统 Prompt。需重启 seek-agent 生效。
    this.promptLocalizationEnabled = /^(true|1|yes)$/i.test(process.env.PROMPT_LOCALIZATION ?? '');
    this.tokenizer = new TokenizerService();
    this.tokenizer.start().catch(() => {});

    // 子模型提交监听：入队后注入 tool 消息对（空闲时触发新一轮）
    setSubmissionListener(() => { this.onSubAgentSubmission().catch(() => {}); });
    // 闹钟监听：到点把 "[闹钟]XX计时器已归零！" 作为 user 消息提交（同注入机制）
    setAlarmListener((msg) => { this.onAlarmFire(msg).catch(() => {}); });

    // 注册进程退出时的 MCP 清理与 instructor 后台流中断
    const cleanup = () => {
      import('./mcp').then(({ shutdownMCP }) => shutdownMCP()).catch(() => {});
      subAgentManager.abortAllInstructors();
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
  /** 查询当前智能搜索模式状态 */
  getSmartSearch(): boolean {
    return this.smartSearchEnabled;
  }

  /** 查询当前思考模式状态 */
  getThinking(): boolean {
    return this.thinkingEnabled;
  }


  /**
   * 构建会话开场指令（随思考模式注入，仅每轮第一次 AI 调用时生效）。
   * 包含：思考模式要求 + 工作流程要点 + 可用工具列表 + 记忆系统提醒。
   */
  private static buildSessionInstruction(): string {
    // 核心工具分组（精确列出，随 tools 容器动态校验存在性）
    const coreGroups: [string, string[]][] = [
      ['文件', ['read_file', 'read_lines', 'scan_file', 'create_file', 'replace_file', 'add_patch', 'del_patch', 'undo_patch', 'history_patch']],
      ['搜索/执行', ['search_all_file', 'search_sub_file', 'search_directory', 'search_content', 'execute_command']],
      ['任务', ['create_todo', 'finish_step', 'undo_step', 'reroll_step', 'del_step', 'read_todo', 'del_todo', 'active_todo']],
      ['记忆', ['memory_add', 'memory_update', 'memory_touch', 'memory_remove', 'memory_list', 'memory_remember', 'memory_recall', 'memory_stats', 'memory_clear']],
      ['桌面/上下文', ['desk_add', 'desk_list', 'desk_remove', 'desk_clear', 'memory_focus', 'memory_shorten']],
    ];
    const known = new Set(coreGroups.flatMap(([, t]) => t));
    // 核心工具按组压缩为计数概览（完整定义见各工具 schema）
    const coreCounts = coreGroups
      .map(([label, t]) => [label, t.filter((n) => n in tools).length] as const)
      .filter(([, c]) => c > 0)
      .map(([label, c]) => `${label}(${c})`)
      .join('、');

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
      `可用工具：核心 ${coreCounts}${skillLine ? '；技能 ' + skillLine : ''}（完整定义见各工具 schema）`,
      '',
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
      platformFile = 'LINUX.md';
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

    // ── 工具使用引导（与工具 schema 分离的跨调用纪律，dsh 式 tool guidance band） ──
    const guidancePath = path.join(promptsDir, 'TOOL_GUIDANCE.md');
    if (fs.existsSync(guidancePath)) {
      parts.push(fs.readFileSync(guidancePath, 'utf-8'));
    }

    // ── 行为记忆（ACTION.md，由行为模式整理师维护；无实质条目时跳过） ──
    const actionPath = path.join(promptsDir, 'ACTION.md');
    if (fs.existsSync(actionPath)) {
      try {
        const actionContent = fs.readFileSync(actionPath, 'utf-8').trim();
        if (actionContent && !/当前记录的行为：\[空\]/.test(actionContent)) {
          parts.push(actionContent);
        }
      } catch {
        // 读取失败则静默跳过
      }
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

    // ── 当前工作目录（含已挂载的多工作区列表，让模型知道可访问的根） ──
    const activeRoot = getWorkspaceRoot();
    const mountedRoots = getWorkspaceRoots();
    if (mountedRoots.length > 1) {
      parts.push(
        `# 可用的工作区\n` +
        `> 当前工作目录：${activeRoot}\n` +
        `> 已挂载工作区（沙箱放行，均可读写访问）：\n` +
        mountedRoots.map(r => `>   - ${r}${r === activeRoot ? '（活跃）' : ''}`).join('\n')
      );
    } else {
      parts.push(`# 可用的工作区\n` +`> 当前工作目录：${activeRoot}`);
    }

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

      // ── 触发 instructor（发信号，后台异步执行，不阻塞主循环） ──
      this.triggerInstructorAfterRound();

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

  /**
   * 登记一条待处理输入：instructor 建议（【xxx 建议】开头）显示为鲸鱼气泡，
   * 其余显示为普通 user 气泡；统一作为 user 消息进入模型上下文。
   */
  private registerUserInput(input: string): void {
    const instMatch = input.match(/^【(.+?) 建议】\n?/);
    if (instMatch) {
      this.ui.addInstructorMessage(input.slice(instMatch[0].length), instMatch[1]);
    } else {
      this.ui.addUserMessage(input);
    }
    this.messages.push({ role: 'user', content: input });
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
    // ── 应用上一轮排定的上下文压缩（记忆消退：移除旧轮次，插入 Worklog） ──
    this.applyPendingCompaction();
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
      this.registerUserInput(input);
    }
    this.ui.addBlankLine();

    // ── 排空子模型待注入的提交（以 tool 消息对注入，不插入 user 气泡） ──
    try {
      this.injectSubmissionsToMessages();
    } catch {
      // 排空失败不影响主流程
    }
    // ── 注入暂存的闹钟消息（安全点，不打断工具调用） ──
    this.injectPendingAlarms();
    this.ui.setProcessing(true);
    toolCache.reset();
    this.roundActualToolCalls = 0;
    this.afterRoundCollapseQueue = [];
    this.lastSingleCollapse = null;

    const roundToolCallIds: string[] = [];
    const roundAssistantTexts: string[] = [];

    try {
      // ── 阶段2：AI 交互循环（含工具调用） ──
      if (getActiveModeNames().includes('hallucination')) {
        // 「100% AI」模式：走独立幻觉循环（万能工具世界，主循环不参与）
        this.illusionAgent ??= new IllusionAgent(this);
        await this.illusionAgent.runRound(userInputs, roundToolCallIds, roundAssistantTexts);
      } else {
        await this.aiInteractionLoop(roundToolCallIds, roundAssistantTexts);
      }
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
      // ── 注入暂存的闹钟消息（安全点，不打断工具调用） ──
      this.injectPendingAlarms();

      // ── 消费 AI 处理期间积累的用户输入 ──
      if (this.inputQueue.length > 0) {
        const pendingInputs = this.drainInputQueue();
        for (const input of pendingInputs) {
          this.registerUserInput(input);
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
        // 思考指令仅在本轮第一次调用时注入，工具循环中间使用纯净 system prompt
        let payloadSystem = thinkingThisCall
          ? `${this.systemPrompt}\n\n${CLIAAgent.buildSessionInstruction()}`
          : this.systemPrompt;
        // 按激活模式过滤（白名单/黑名单）后剥离 execute，避免 AI SDK 内部自动执行工具导致双重执行
        let payloadTools = stripToolExecutes(filterToolsForActiveModes(tools));
        // Prompt 本地化：system 直接复用最近一次实际发送的 payload 快照
        // （system 内含工作区信息，固定后不随技能启停/工作区切换/文件变化漂移），
        // 首轮无快照时仍动态组装一次作为种子，recordPayload 后后续轮次自动固定。
        // 注意：tools 不直接复用 payload 快照——loadsession 恢复的 payload 经 JSON
        // round-trip 会丢失 AI SDK 的 Schema 包装（symbol/getter 不可序列化），直接传给
        // streamText 会触发 asSchema 崩溃（TypeError: schema is not a function）。
        // 工具集始终使用当前动态 schema（stripToolExecutes 后的内存对象）。
        if (this.promptLocalizationEnabled) {
          const snap = this.payloadHistory[this.payloadHistory.length - 1];
          if (snap && typeof snap.system === 'string' && snap.system.length > 0) {
            payloadSystem = snap.system;
          }
        }
        // messages 深拷贝快照：与 this.messages 同引用，后续 push 会污染历史记录
        this.recordPayload({
          system: payloadSystem,
          messages: JSON.parse(JSON.stringify(messagesForModel)) as ModelMessage[],
          tools: payloadTools,
          thinking: thinkingThisCall,
        });
        const result = await streamText({
          model: getModel(this.modelName),
          system: payloadSystem,
          messages: messagesForModel,
          tools: payloadTools,
          abortSignal: abortController.signal,
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
        // ── 上下文预算监测：超限则调度记忆消退压缩（异步执行，不阻塞本轮） ──
        try {
          const usage = await finalResult.usage;
          if (usage?.inputTokens) {
            this.maybeScheduleCompaction(usage.inputTokens);
          }
          this.accumulateUsage(usage);
        } catch { /* usage 不可用时跳过 */ }
        if (finalResult.toolCalls) {
          const tl = await finalResult.toolCalls;
          for (const tc of tl) {
            // 修复工具调用参数：AI SDK 解析非法 JSON 时会回退为原始字符串，
            // 导致消息数组损坏（下一轮 provider 400）。
            // 同时解包 _raw/input 等包装参数（模型格式漂移），让后续消息记录与执行都用扁平参数。
            tc.input = sanitizeToolInput(unwrapToolArgs(tc.input));
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
    // 并行 patch 检测：同批（同一条 assistant 消息）≥2 个 patch 作用于同一文件 → 静默建批次
    await this.beginPatchBatches(toolCalls);
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


      let toolImpl = tools[toolName as keyof typeof tools];
      if (!toolImpl?.execute) {
        // 工具不在 toolsContainer 中 → 尝试懒加载激活
        const resolved = resolveLazyTool(toolName);
        if (resolved?.execute) {
          toolImpl = resolved;
        } else {
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
      }

      // ── 编辑模式拦截 ──
      if (deskEditManager.isActive()) {
        if (!DESK_EDIT_TOOLS.has(toolName)) {
          const errMsg = `⛔ 当前处于桌面编辑模式，仅支持桌面编辑工具（desk_edit, line_cursor, line_paste, ctrl_z, desk_save, desk_cancel）。请先调用 desk_save 退出编辑模式。`;
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

      // ── 行为记忆采样：累计实际工具调用达窗口时后台蒸馏（fire-and-forget，不阻塞） ──
      void maybeDistillActions(this.messages, () => this.reloadPrompt());

    }

    // ── 处理中断/中止（submission 留在队列中，下一轮安全时再排空） ──
    if (interruptedByInput) {
      patchBatch.discardAll(); // 放弃暂存批次（未写盘），文件保持原状
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
      patchBatch.discardAll();
      return false;
    }

    // ── 正常退出：flush 并行 patch 批次（基于基准快照从后往前合并应用） ──
    await this.flushPatchBatches();

    // ── 排空子模型待注入的提交（仅在正常退出时，避免被 rollback 误删；以 tool 消息对注入） ──
    try {
      this.injectSubmissionsToMessages();
    } catch { /* 排空失败不影响 */ }
    // ── 注入暂存的闹钟消息（正常退出时） ──
    this.injectPendingAlarms();

    return false;
  }

  /**
   * 并行 patch 检测：同一条 assistant 消息里对同一文件有 ≥2 个 patch 调用时，
   * 建立静默暂存批次（记录基准快照）。patch 工具执行时检测到批次模式会只入暂存不写盘。
   */
  private async beginPatchBatches(toolCalls: any[]): Promise<void> {
    try {
      const counts = new Map<string, number>();
      for (const tc of toolCalls) {
        if (!PATCH_TOOL_NAMES.has(tc.toolName)) continue;
        const fp = tc.input?.filePath;
        if (!fp) continue;
        const key = resolvePath(String(fp)).replace(/\\/g, '/');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const [key, n] of counts) {
        if (n < 2) continue;
        const { lines, hasTrailingNewline, lineEnding } = await readFileLines(key);
        patchBatch.beginBatch(key, lines, hasTrailingNewline, lineEnding);
      }
    } catch { /* 检测失败不影响主流程 */ }
  }

  /** flush 并行 patch 批次：成功仅 UI 汇总；失败注入模型上下文（user 消息）供模型修正 */
  private async flushPatchBatches(): Promise<void> {
    const results = await patchBatch.flushAll();
    for (const r of results) {
      if (r.ok) {
        this.ui.addToolMessage(`📦 ${r.message}\n📄 文件：${r.filePath}\n📐 行数：${r.fromLines} → ${r.toLines} 行（diff 已持久化，undo_patch 可整体回滚）`);
      } else {
        const errMsg = `❌ ${r.message}\n📄 文件：${r.filePath}\n（文件保持原状，可修正后重试）`;
        this.ui.addToolMessage(errMsg);
        this.messages.push({ role: 'user', content: `【批次应用失败】${r.filePath}\n${r.message}` });
      }
    }
  }

  // ────────────────────────────────────────────────
  // 上下文压缩（记忆消退路径）
  // ────────────────────────────────────────────────

  /**
   * 上下文预算超限时调度记忆消退压缩。
   * 压缩由副模型异步执行（不阻塞主循环），结果暂存，下一轮输入安全点应用。
   * 门控：压缩任务在飞或已有待应用计划时不再重复调度（一轮最多一次）。
   */
  private maybeScheduleCompaction(inputTokens: number): void {
    if (this.pendingCompaction || this.compactionInFlight) return;
    if (!checkBudget(inputTokens)) return;

    // 分层保真：最旧一轮占比超阈值时，先同步把该轮幂等工具结果简化为"已遗忘，请重新读取"
    // （不移除、不产生 Worklog、不归档）。回落预算内则跳过该轮（等下次清理），仍超才走归档。
    const slimmed = slimOldestRound(this.messages);
    if (slimmed) {
      this.messages = slimmed;
      if (!checkBudget(estimateMessagesTokens(this.messages))) return;
    }

    this.compactionInFlight = true;
    const snapshot = [...this.messages];
    const sessionId = this.sessionId;
    compactMessages(snapshot, sessionId, inputTokens)
      .then((plan) => {
        this.compactionInFlight = false;
        if (plan) this.pendingCompaction = plan;
      })
      .catch(() => {
        this.compactionInFlight = false;
      });
  }

  /**
   * 把一次调用的 usage 折入会话累计四桶（互补互斥：uncached input / output / cacheRead / cacheWrite），
   * 并按 dsh 的 cacheHitRate 公式计算缓存命中率后推送到 UI（输入框下方灰色小字）。
   */
  private accumulateUsage(usage: any): void {
    if (!usage || typeof usage !== 'object') return;
    const detail = usage.inputTokenDetails ?? usage.inputTokensDetails ?? {};
    const cacheRead = normalizeToken(detail.cacheReadTokens) ?? 0;
    const cacheWrite = normalizeToken(detail.cacheWriteTokens) ?? 0;
    const noCache = normalizeToken(detail.noCacheTokens);
    const billedInput = normalizeToken(usage.inputTokens) ?? 0;
    // uncached 输入优先取 provider 明确上报的 noCache，缺失时由 billed 反推（clamp 到非负）
    const uncachedInput = noCache ?? Math.max(0, billedInput - cacheRead - cacheWrite);
    const output = normalizeToken(usage.outputTokens) ?? 0;

    const t = this.usageTotals;
    t.inputTokens += uncachedInput;
    t.outputTokens += output;
    t.cacheReadTokens += cacheRead;
    t.cacheWriteTokens += cacheWrite;

    const denominators = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    const cacheHitRate = denominators > 0 ? Math.round((t.cacheReadTokens / denominators) * 100) : null;
    this.ui.setUsageSummary({ ...t, cacheHitRate });
  }

  /**
   * 应用待定的压缩计划（安全点：processRound 开头）。
   * 移除最旧轮次消息，插入 Worklog（及可能的归档行）。
   * 被移除消息的原文已由压缩阶段写入归档存储（work_recall 可召回）。
   */
  private applyPendingCompaction(): void {
    const plan = this.pendingCompaction;
    if (!plan) return;
    this.pendingCompaction = null;
    if (this.messages.length === 0) return;

    const removeCount = Math.min(plan.removeCount, this.messages.length);
    this.messages.splice(0, removeCount, ...plan.insertMessages);
    // 静默应用：移除旧轮次，插入 Worklog（不打扰 UI，召回走 worklog_recall）
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

  /**
   * 闹钟到点回调：把 "[闹钟]XX计时器已归零！" 作为 user 消息注入。
   * 空闲时直接 run 启动新一轮；处理中则暂存 pendingAlarmMessages，
   * 由安全点（processRound 开头 / aiInteractionLoop 顶部 / executeToolCalls 末尾）注入——
   * 不进 inputQueue，避免被 executeToolCalls 当作新输入打断正在进行的工具调用（与子 agent 提交同机制）。
   */
  async onAlarmFire(msg: string): Promise<void> {
    if (!this.processingPromise) {
      await this.run(msg);
    } else {
      this.pendingAlarmMessages.push(msg);
    }
  }

  /** 排空暂存的闹钟消息，注入为 user 消息（安全点调用；不打断正在进行的工具调用） */
  private injectPendingAlarms(): number {
    if (this.pendingAlarmMessages.length === 0) return 0;
    const msgs = this.pendingAlarmMessages;
    this.pendingAlarmMessages = [];
    for (const msg of msgs) {
      this.registerUserInput(msg);
    }
    return msgs.length;
  }
  // ────────────────────────────────────────────────

  // ────────────────────────────────────────────────
  // Instructor 触发
  // ────────────────────────────────────────────────

  /**
   * 每轮主模型工作完成后，向所有 instructor 发信号发散思维提出建议。
   * 信号只做检查与派发（fire-and-forget），不阻塞主循环：
   * instructor 在后台异步执行，完成后把建议作为用户输入直接入队开启主模型下一轮。
   * 如果本轮处理的是真实用户输入（非 instructor 自产的消息），重置轮次计数。
   * 如果用户在此过程中终止，已中断的轮次不会触发 instructor。
   */
  private triggerInstructorAfterRound(): void {
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

      // instructor 正在后台运行（上一轮信号尚未完成）→ 跳过本次触发，避免建议堆积
      if (instructor.status === 'running') continue;

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

      // ── 发信号：后台异步执行 instructor，主循环立即返回 ──
      void this.runInstructorAsync(instructor, lastOutput);
    }
  }

  /**
   * 后台执行 instructor：完成后把建议作为用户输入直接 push 进 inputQueue，
   * 开启主模型下一轮（保持“建议 = 用户输入”的语义）。
   */
  private async runInstructorAsync(
    instructor: SubAgentState,
    lastOutput: string,
  ): Promise<void> {
    try {
      const { executeInstructorAgent } = await import('./tools/inner_skills/sub-agent/runner');
      const result = await executeInstructorAgent(instructor, lastOutput);
      if (!result?.trim()) return;

      // instructor 运行期间主模型被中断/销毁 → 丢弃建议
      if (this.aborted || this.ui.isAborted) return;

      const msg = `【${instructor.name} 建议】\n${result}`;
      this.ui.addToolMessage(`■ 收到 ${instructor.name} 的建议，继续下一轮处理`);
      this.inputQueue.push(msg);

      // 主模型空闲时启动处理循环消费建议（直接开启下一轮）；
      // 若处理循环仍在跑，inputQueue 会被其下一轮自动消费
      this.ensureProcessingLoop();
    } catch {
      // instructor 执行失败不影响主流程
    }
  }

  /**
   * 确保存在处理循环消费 inputQueue。
   * 竞态兜底：若现有 loop 正在退出（while 判断空但 finally 尚未置 null），
   * processingPromise 非空会导致直接启动不成立 → 建议滞留；微任务后再查一次。
   */
  private ensureProcessingLoop(): void {
    if (!this.processingPromise) {
      this.processingPromise = this.runProcessingLoop().finally(() => {
        this.processingPromise = null;
      });
      return;
    }
    queueMicrotask(() => {
      // loop 已结束且建议仍未被消费 → 补启动
      if (!this.processingPromise && this.inputQueue.length > 0) {
        this.processingPromise = this.runProcessingLoop().finally(() => {
          this.processingPromise = null;
        });
      }
    });
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
    this.pendingAlarmMessages = [];
    this.sessionTitle = '';
    this.payloadHistory = [];
    this.sessionId = this.generateSessionId();
    // 新会话：归档与子 Agent 上下文分区跟随新 id
    worklogStore.setSessionId(this.sessionId);
    subagentContextStore.setSessionId(this.sessionId);
    docPoolStore.setSessionId(this.sessionId);
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

  /** 获取发给模型的完整 payload 历史（用于保存会话 / WebUI 记忆面板） */
  getPayloadHistory(): PayloadRecord[] {
    return this.payloadHistory;
  }

  /** Prompt 本地化是否开启（WebUI「记忆」面板可用性判断） */
  isPromptLocalizationEnabled(): boolean {
    return this.promptLocalizationEnabled;
  }

  /**
   * Prompt 本地化写回：应用编辑后的 system prompt 快照（WebUI「记忆」面板）。
   * 更新 payloadHistory 最近一条的 system，后续轮次本地化快照即用新值，
   * 并立即保存会话（payload.json）持久化，进程重启后编辑仍保留。
   * 返回是否应用成功（需开启本地化且已有快照）。
   */
  applyLocalizedSystem(system: string): boolean {
    if (!this.promptLocalizationEnabled) return false;
    if (!system || !system.trim()) return false;
    const last = this.payloadHistory[this.payloadHistory.length - 1];
    if (!last) return false;
    last.system = system;
    try { this.saveSessionToDisk(); } catch { /* 保存失败不影响内存生效 */ }
    return true;
  }

  /** 设置 payload 历史（用于从文件恢复会话，超限截断） */
  setPayloadHistory(records: PayloadRecord[]): void {
    this.payloadHistory = Array.isArray(records)
      ? records.slice(-MAX_PAYLOAD_HISTORY)
      : [];
  }

  /** 记录一次发给模型的完整 payload（自动打时间戳，保留最近 MAX_PAYLOAD_HISTORY 条） */
  private recordPayload(rec: Omit<PayloadRecord, 'ts'>): void {
    this.payloadHistory.push({ ...rec, ts: new Date().toISOString() });
    if (this.payloadHistory.length > MAX_PAYLOAD_HISTORY) {
      this.payloadHistory.splice(0, this.payloadHistory.length - MAX_PAYLOAD_HISTORY);
    }
  }

  // ────────────────────────────────────────────────
  // 自动保存
  // ────────────────────────────────────────────────

  /**
   * 把当前会话保存到 sessions/{sessionId}/ 文件夹（文件夹名 = 稳定 sessionId）：
   *   session.json — 主会话（agentMessages + 元数据，不含 payloads）
   *   payload.json — 发给模型的完整 payload 历史（独立文件，供 WebUI「记忆」面板）
   * 文件夹落点固定，标题变化不影响存储位置。返回文件夹路径；无消息时不创建。
   */
  saveSessionToDisk(): string | null {
    const messages = this.messages;
    if (messages.length === 0) return null;

    const safeId = this.sessionId.replace(/[\\\/:*?"<>|]/g, '_');
    const sessionDir = path.join(getSessionsRoot(), 'sessions', safeId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const sessionData = {
      version: 2,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      title: this.sessionTitle,
      cwd: getWorkspaceRoot(),
      workspace: { roots: getWorkspaceRoots(), active: getWorkspaceRoot() }, // 多工作区状态（重启恢复用）
      mode: getActiveModeNames(), // 模式随会话持久化（切回时恢复）
      agentMessages: messages,
    };
    const payloadData = {
      version: 1,
      sessionId: this.sessionId,
      payloads: this.payloadHistory,
    };

    try {
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionData, null, 2), 'utf-8');
      fs.writeFileSync(path.join(sessionDir, 'payload.json'), JSON.stringify(payloadData, null, 2), 'utf-8');
      // 子 Agent 注册状态持久化（loadsession 切换会话时据此恢复子 Agent 并接入工具系统）
      // 只存属于当前会话的子 Agent——跨会话后台任务（owner 是其他会话）不进本会话 registry
      subagentRegistryStore.save(subAgentManager.getAll()
        .filter((a) => !a.ownerSessionId || a.ownerSessionId === this.sessionId)
        .map((a) => ({
          name: a.name,
          mode: a.mode,
          tools: a.tools ?? [],
          systemPrompt: a.systemPrompt,
          context: a.context,
          requirement: a.requirement,
          maxRounds: a.maxRounds,
          createdAt: a.createdAt,
          instructorRoundCount: a.instructorRoundCount,
          instructorMessages: a.instructorMessages,
        })));
      return sessionDir;
    } catch {
      return null; // 自动保存失败不影响主流程
    }
  }

  /** 每轮结束后自动保存当前会话（文件夹化：session.json + payload.json） */
  private autoSaveSession(): void {
    this.saveSessionToDisk();
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
      // 立即重存（落点固定为 sessionId 文件夹，无需清理旧文件）
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
        !m.content.startsWith('[知识库检索]') &&
        !m.content.startsWith('[Worklog#'),
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

  /** 生成新的会话 ID（统一 session-xxxx-xxxx-xxxx 形态；TUI/clear 等无 AGENT_SESSION_ID 场景） */
  private generateSessionId(): string {
    const rand = () => Math.random().toString(36).substring(2, 6);
    return `session-${rand()}-${rand()}-${rand()}`;
  }

  /** 设置会话 ID（用于从文件恢复会话时指定），并同步 worklog 归档与子 Agent 上下文分区 */
  /** 设置会话 ID（用于从文件恢复会话时指定），并同步 worklog 归档与子 Agent 上下文分区 */
  setSessionId(id: string): void {
    this.sessionId = id;
    worklogStore.setSessionId(id);
    subagentContextStore.setSessionId(id);
    subagentRegistryStore.setSessionId(id);
    docPoolStore.setSessionId(id);
  }

  /** 获取当前会话 ID（用于保存/定位 session 文件夹） */
  getSessionId(): string {
    return this.sessionId;
  }
}















































































































































































































