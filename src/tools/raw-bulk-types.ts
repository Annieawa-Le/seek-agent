/**
 * raw-bulk-types.ts — RawBulk 类型系统
 *
 * 每个工具执行后返回 RawBulk 对象（结构化功能数据），
 * 由三端格式化器分别消费：
 *   - AI Formatter   → 模型 tool result 文本
 *   - TUI Renderer   → 终端显示（含 ANSI）
 *   - WebUI Renderer → Electron 结构化渲染
 */

// ============================================================
// RawBulk 基础类型
// ============================================================

/** 读取类工具的结果 */
export interface ReadFileBulk {
  type: 'read';
  filePath: string;
  content: string;
  lineCount: number;
  charCount: number;
  truncated?: boolean;
  /** 行号范围（部分读取时） */
  startLine?: number;
  endLine?: number;
  /** 带行号内容（read_lines / scan_file 时） */
  numberedLines?: Array<{ lineNum: number; content: string }>;
  error?: string;
}

/** 搜索类工具的结果 */
export interface SearchBulk {
  type: 'search';
  filePath: string;
  pattern: string;
  results: Array<{ name: string; path: string; isDir?: boolean }>;
  /** 匹配总数（未截断时与 results.length 一致） */
  totalCount: number;
  /** 结果是否因超过 maxResults 被截断 */
  truncated: boolean;
  error?: string;
}

/** 内容搜索工具的结果 */
export interface SearchContentBulk {
  type: 'search-content';
  filePath: string;
  pattern: string;
  /** 返回的匹配行数 */
  totalCount: number;
  matches: Array<{ lineNum: number; line: string; filePath?: string }>;
  /** 结果是否被截断（目录搜索时每文件 50 行 / 全局 maxResults 上限） */
  truncated?: boolean;
  error?: string;
}

/** 命令执行结果 */
export interface ExecBulk {
  type: 'exec';
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  truncated: boolean;
  error?: string;
  /** 命令超过时限转入后台任务的标记 */
  deferred?: boolean;
  /** 转后台后的任务名（deferred 时） */
  taskName?: string;
  /** 本次超时时限毫秒数（deferred 时用于提示） */
  timeoutMs?: number;
}

/** 文件创建/覆写结果 */
export interface FileWriteBulk {
  type: 'file-write';
  action: 'create' | 'replace';
  filePath: string;
  fileName?: string;
  charCount: number;
  error?: string;
}

/** Patch 操作结果（直接写入模式） */
export interface PatchBulk {
  type: 'patch';
  action: 'add' | 'del' | 'modify' | 'replace' | 'undo' | 'history';
  filePath?: string;
  description: string;
  /** diff 字符串 */
  diff?: string;
  /** 撤销 ID */
  undoId?: string;
  /** history 时暂存撤销栈大小 */
  stagingSize?: number;
  error?: string;
}

/** 参考桌面操作结果 */
export interface DeskBulk {
  type: 'desk';
  action: 'add' | 'list' | 'remove' | 'clear';
  filePath?: string;
  totalCount: number;
  entries?: Array<{ filePath: string; charCount: number }>;
  error?: string;
}

/** 后台任务状态 */
export type TaskStatus = 'running' | 'done' | 'failed' | 'killed';

/** 后台任务管理操作结果 */
export interface TaskBulk {
  type: 'task';
  action: 'execute' | 'switch' | 'list' | 'kill';
  taskName?: string;
  command?: string;
  /** 任务当前状态（execute/switch/kill 时） */
  status?: TaskStatus;
  pid?: number;
  exitCode?: number | null;
  /** switch 时返回的输出尾部片段 */
  output?: string;
  /** 输出是否被截断（超过 tail 限制或缓冲上限） */
  outputTruncated?: boolean;
  /** 完整 stdout 字符数 */
  stdoutChars?: number;
  /** switch 使用 wait 参数等待超时（任务仍运行） */
  waitTimedOut?: boolean;
  /** list 时返回的任务摘要列表 */
  tasks?: Array<{
    name: string;
    command: string;
    status: TaskStatus;
    running: boolean;
    exitCode?: number | null;
    startedAt: number;
    durationMs?: number;
    stdoutChars: number;
    stderrChars: number;
  }>;
  error?: string;
}

/** 待办事项操作结果 */
export interface TodoBulk {
  type: 'todo';
  action: 'create' | 'finish' | 'undo' | 'reroll' | 'del-step' | 'read' | 'del' | 'active' | 'finish-to';
  name: string;
  /** 已完成步数 */
  doneCount: number;
  /** 总步数 */
  totalCount: number;
  steps?: Array<{ content: string; completed: boolean }>;
  /** 最近一次操作涉及的步骤说明 */
  stepInfo?: string;
  /** 当前活跃 todo 名称（active 查询时） */
  active?: string | null;
  error?: string;
}

/** 上下文记忆管理 + 对话记忆操作 */
export type MemoryAction =
  | 'focus' | 'shorten'
  | 'add' | 'update' | 'touch' | 'remove' | 'list' | 'clear'
  | 'remember' | 'recall' | 'stats';

/** 上下文记忆管理结果 */
export interface MemoryBulk {
  type: 'memory';
  action: MemoryAction;
  /** 被压缩/精简的轮次数（focus/shorten） */
  roundsCompressed?: number;
  /** 移除的消息条数（focus） */
  messagesRemoved?: number;
  /** 插入的梗概消息条数（focus） */
  messageInserted?: number;
  /** 被精简为 success 的结果数（shorten） */
  resultsShortened?: number;
  /** 梗概内容（focus） */
  summary?: string;
  // ── 对话记忆字段 ──
  /** 操作后的记忆条数 */
  itemCount?: number;
  /** 涉及的记忆 id（update/touch/remove） */
  itemId?: number;
  /** 记忆权重（add 时） */
  weight?: number;
  /** 记忆内容（add/remember 时） */
  content?: string;
  /** remember 去重跳过标记 */
  skipped?: boolean;
  skipReason?: string;
  /** recall/list 的检索结果 */
  results?: Array<{ id?: number; content: string; score?: number; weight?: number; createdAt?: string; source?: string }>;
  error?: string;
}

/** 任务段（mission）上下文归档结果 */
export interface MissionBulk {
  type: 'mission';
  action: 'start' | 'accomplish' | 'cancel';
  /** 任务段名称（归档标题） */
  name: string;
  /** 归档的 Worklog id（accomplish 时） */
  worklogId?: string;
  /** 归档标题（accomplish 时） */
  title?: string;
  /** 移出上下文的消息条数（accomplish 时） */
  messagesRemoved?: number;
  /** 归档梗概（accomplish 时） */
  summary?: string;
  error?: string;
}

/** 闹钟操作结果 */
export interface AlarmBulk {
  type: 'alarm';
  action: 'set' | 'cancel' | 'list';
  /** 闹钟名（set / cancel） */
  label?: string;
  /** 设定时长（秒，set） */
  durationSec?: number;
  /** 到点时刻的本地时间字符串（set） */
  fireAt?: string;
  /** 是否成功（cancel 时表示是否找到并取消） */
  ok?: boolean;
  /** 未到点的闹钟（list） */
  alarms?: Array<{ label: string; remainingMs: number }>;
  error?: string;
}

/** 跨会话协作消息发送结果 */
export interface CollabBulk {
  type: 'collab';
  action: 'send';
  /** 目标会话 id 或标题 */
  target?: string;
  /** 消息是否已送达 */
  delivered?: boolean;
  /** 目标会话当时是否活跃（false = 未唤醒） */
  active?: boolean;
  error?: string;
}

// ============================================================
// 统一 RawBulk 联合类型

export type RawBulk =
  | ReadFileBulk
  | SearchBulk
  | SearchContentBulk
  | ExecBulk
  | FileWriteBulk
  | PatchBulk
  | DeskBulk
  | TaskBulk
  | TodoBulk
  | MemoryBulk
  | MissionBulk
  | WorklogBulk
  | CmdLogBulk
  | AlarmBulk
  | CollabBulk;
// ============================================================
// 格式化器接口
// ============================================================

/**
 * AI Formatter: rawBulk → AI 友好的 tool result 文本
 * TUI Renderer: rawBulk → 带 ANSI 色的终端显示文本
 * WebUI Renderer: rawBulk → Electron 渲染用的结构化 JSON
 */
export interface RawBulkFormatters {
  toAIText(rawBulk: RawBulk): string;
  toTUIText(rawBulk: RawBulk): string;
  toWebUI(rawBulk: RawBulk): Record<string, unknown>;
}






/** Worklog 召回操作结果（记忆消退路径） */
export interface WorklogBulk {
  type: 'worklog';
  action: 'recall' | 'recall-original';
  /** 是否命中 */
  found: boolean;
  /** 查询的 id 或标题关键词 */
  query: string;
  /** 命中的 Worklog id */
  id?: string;
  /** 标题 */
  title?: string;
  /** 梗概（recall 时） */
  summary?: string;
  /** 原文大小（recall-original 时） */
  size?: number;
  msg: string;
}

/** 命令日志召回结果（command_log） */
export interface CmdLogBulk {
  type: 'cmd-log';
  action: 'read';
  /** 是否命中（日志文件存在） */
  found: boolean;
  /** 日志文件路径 */
  filePath: string;
  /** 日志总字符数 */
  size: number;
  /** 返回内容是否因超过 maxChars 被截断 */
  truncated: boolean;
  /** 返回内容（正文） */
  content?: string;
  error?: string;
}


















