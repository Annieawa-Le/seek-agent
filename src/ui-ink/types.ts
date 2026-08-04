/** 消息类型：与旧版 TerminalUI 完全一致，electron-bridge 跨端共享 */
export interface UIMessage {
  role: 'user' | 'agent' | 'system' | 'tool' | 'divider' | 'banner' | 'blank' | 'subagent' | 'instructor' | 'thinking';
  content: string;
  /** 消息创建时间戳（毫秒） */
  createdAt?: number;
  /** 子模型提交的名称（仅 subagent 角色使用） */
  subagentName?: string;
  /** 折叠状态（仅 tool 消息使用） */
  collapsed?: boolean;
  /** 工具元信息（折叠时用于渲染工具名和参数） */
  toolMeta?: { toolName: string; args: Record<string, unknown> };
  /** 结构化功能数据（工具结果，供多端消费） */
  rawBulk?: import('../tools/raw-bulk-types').RawBulk;
  /** 工具调用参数 HTML（实时流式中由 bridge 生成，重建会话时透传） */
  toolCallHtml?: string;
  /** 工具结果 HTML（实时流式中由 toWebUI 生成，重建会话时透传） */
  toolResultHtml?: string;
  /** 工具结果的完整原始输出（未截断） */
  fullOutput?: string;
  /** 标记为「不渲染」，用于移除已折叠工具的调用消息而不影响其他索引 */
  doNotRender?: boolean;
}

/** Ink 渲染快照：useSyncExternalStore 消费的不可变状态 */
export interface UIState {
  /** 消息列表（不可变引用，每次变更替换新数组） */
  messages: UIMessage[];
  /** 当前输入缓冲区文本 */
  input: string;
  /** 光标位置（字符索引） */
  cursorPos: number;
  /** 历史浏览索引（-1 表示正在编辑新输入） */
  historyIndex: number;
  /** 是否正在处理 AI 请求 */
  isProcessing: boolean;
  /** 思考模式是否激活 */
  thinkingActive: boolean;
  /** 已积累的思考文本 */
  thinkingText: string;
  /** spinner 帧索引 */
  spinnerIndex: number;
  /** 审查中子 agent 名称（null 表示未在审查） */
  listenName: string | null;
  /** 上下文字符数 */
  contextChars: number;
  /** 上下文 token 数（0 表示未计算） */
  contextTokens: number;
  /** 上下文历史峰值 */
  maxContextChars: number;
  /** 实际工具调用数 */
  toolCallCount: number;
  /** 滚动偏移（从底部跳过的消息条数，0=最新） */
  scrollOffset: number;
  /** 提示符文本 */
  promptText: string;
  /** 命令叠加层是否打开 */
  paletteOpen: boolean;
  /** 叠加层搜索词 */
  paletteQuery: string;
  /** 叠加层当前选中项索引（在过滤后的列表中） */
  /** 叠加层当前选中项索引（在过滤后的列表中） */
  paletteIndex: number;
  /** 当前 git 分支名（空字符串表示未知） */
  gitBranch: string;
}


