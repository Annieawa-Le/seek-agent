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
  /** 带行号内容（read_num_line / scan_file 时） */
  numberedLines?: Array<{ lineNum: number; content: string }>;
  error?: string;
}

/** 搜索类工具的结果 */
export interface SearchBulk {
  type: 'search';
  filePath: string;
  pattern: string;
  results: Array<{ name: string; path: string }>;
  totalCount: number;
  truncated: boolean;
  error?: string;
}

/** 内容搜索工具的结果 */
export interface SearchContentBulk {
  type: 'search-content';
  filePath: string;
  pattern: string;
  totalCount: number;
  matches: Array<{ lineNum: number; line: string }>;
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

/** Patch 暂存操作结果 */
export interface PatchStagingBulk {
  type: 'patch';
  action: 'add' | 'del' | 'modify' | 'pop' | 'ensure' | 'check' | 'revise';
  filePath?: string;
  description: string;
  stagingSize: number;
  /** ensure_patch 的结果 */
  applied?: number;
  failed?: number;
  perFile?: Array<{
    filePath: string;
    patchCount: number;
    results: string[];
  }>;
  /** check_patch 的详情 */
  patchDetail?: {
    index: number;
    toolType: string;
    params: Record<string, unknown>;
    resultMessage?: string;
  };
  /** ensure = false 时的清空记录 */
  abandoned?: number;
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

// ============================================================
// 统一 RawBulk 联合类型
// ============================================================

export type RawBulk =
  | ReadFileBulk
  | SearchBulk
  | SearchContentBulk
  | ExecBulk
  | FileWriteBulk
  | PatchStagingBulk
  | DeskBulk;

// ============================================================
// 工具执行返回值
// ============================================================

export interface ToolResult {
  /** 结构化功能数据 */
  rawBulk: RawBulk;
  /** AI 友好的格式化文本（可选，不提供则由通用 AI Formatter 生成） */
  aiText?: string;
}

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
