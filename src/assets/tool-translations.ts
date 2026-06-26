/**
 * tool-translations.ts — 基本工具调用翻译配置
 *
 * 为每个基本工具（不含 inner_skills）定义 TUI 渲染格式，
 * 供 agent 生成友好调用标签使用；可在外部覆写以自定义展示效果。
 *
 * 用法示例（覆写某个工具的图标或标签）：
 *   import { getToolTranslation, registerTool } from './assets/tool-translations';
 *   registerTool('execute_command', { icon: '⚡', category: 'exec', callLabel: (args) => ... });
 */
import * as path from 'node:path';
/** 蓝灰色（用于省略提示行） */
const BLUE_GRAY = '\x1b[38;2;112;128;144m';
/** 紫色（用于数字高亮） */
const PURPLE = '\x1b[35m';

export interface ToolTranslation {
  /** 显示图标（如 ■ ） */
  icon: string;
  /** 工具类别 */
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  /** 生成调用标签 */
  callLabel: (args: Record<string, unknown>) => string;
  /** 折叠模式：不折叠 | 单次折叠（立即折叠为仅工具名+参数）| 轮后折叠（本轮结束后折叠） */
  collapse?: 'never' | 'single' | 'after-round';
}

// ── 类别索引（快速判断工具属于哪一类） ──
export const READ_TOOLS   = new Set<string>();
export const SEARCH_TOOLS = new Set<string>();
export const EXEC_TOOLS   = new Set<string>();
export const FILE_TOOLS   = new Set<string>();
export const PATCH_TOOLS  = new Set<string>();
export const DESK_TOOLS   = new Set<string>();
export const OTHER_TOOLS  = new Set<string>();

const ALL_TOOLS = new Map<string, ToolTranslation>();
const catMap: Record<string, Set<string>> = {
  read: READ_TOOLS, search: SEARCH_TOOLS, exec: EXEC_TOOLS,
  file: FILE_TOOLS, patch: PATCH_TOOLS, desk: DESK_TOOLS,
  other: OTHER_TOOLS,
};

function def(
  name: string,
  category: ToolTranslation['category'],
  icon: string,
  labelFn: (args: Record<string, unknown>) => string,
  collapse?: 'never' | 'single' | 'after-round',
): void {
  ALL_TOOLS.set(name, { icon, category, callLabel: labelFn, collapse: collapse ?? 'never' });
  catMap[category]?.add(name);
}


/**
 * 将文件路径格式化为带亮蓝+下划线的可点击链接（OSC 8 超链接）。
 * 终端支持时路径可点击跳转，不支持时至少保持亮蓝+下划线样式。
 */
function makeReadPathLabel(fp: string): string {
  const absPath = path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp);
  const normalized = absPath.split(path.sep).join('/');
  const uri = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
  // OSC 8 超链接 + 亮蓝(94) + 下划线(4)
  return `\x1b]8;;${uri}\x1b\\\x1b[94m\x1b[4m${fp}\x1b[0m\x1b]8;;\x1b\\`;
}
// ═════════════════════════════════════════════════════
// 基本工具注册（对应 src/tools/index.ts 中的 coreTools）
// ═════════════════════════════════════════════════════

// ── 读取类 ──
def('read_file', 'read', '■', (args) => {
  const fp = (args?.filePath ?? args?.path ?? '(?)') as string;
  return `读取: ${makeReadPathLabel(fp)}`;
}, 'single');

def('read_lines', 'read', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const start = args?.startLine ?? '?';
  const end = args?.endLine ?? '?';
  return `读取: ${makeReadPathLabel(fp)} (行 ${start}-${end})`;
}, 'single');

def('read_num_line', 'read', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const start = args?.startLine ?? '?';
  const end = args?.endLine ?? '?';
  return `读取(带行号): ${makeReadPathLabel(fp)} (行 ${start}-${end})`;
}, 'single');

def('scan_file', 'read', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  return `扫描: ${makeReadPathLabel(fp)}`;
}, 'single');
// ── 搜索类 ──
def('search_all_file', 'search', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const name = (args?.fileName ?? '(?)') as string;
  return `搜索: ${fp} (${name})`;
}, 'after-round');

def('search_sub_file', 'search', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const name = (args?.fileName ?? '(?)') as string;
  return `搜索: ${fp} (${name})`;
}, 'after-round');

def('search_directory', 'search', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  return `搜索目录: ${fp}`;
}, 'after-round');

def('search_content', 'search', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const content = (args?.content ?? '(?)') as string;
  return `搜索内容: ${fp} (${content})`;
}, 'after-round');

// ── 执行类 ──
def('execute_command', 'exec', '■', (args) => {
  const cmd = (args?.command ?? args?.cmd ?? '(?)') as string;
  const short = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
  return `执行: ${short}`;
}, 'after-round');

// ── 文件操作 ──
def('create_file', 'file', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const fn = (args?.fileName ?? '(?)') as string;
  return `创建文件: ${fp}/${fn}`;
}, 'after-round');

def('replace_file', 'file', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  return `覆写文件: ${fp}`;
}, 'after-round');

// ── 暂存操作 ──
def('add_patch', 'patch', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const line = args?.lineIndex ?? '?';
  return `暂存插入: ${fp} (行 ${line})`;
}, 'after-round');

def('del_patch', 'patch', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  const range = JSON.stringify(args?.lineIndex ?? '?');
  return `暂存删除: ${fp} (范围 ${range})`;
}, 'after-round');

def('modify_patch', 'patch', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  return `修改: ${fp}`;
}, 'after-round');
def('undo_patch', 'patch', '↩', () => {
  return '撤销最近的文件修改';
}, 'after-round');
def('history_patch', 'patch', '■', () => {
  return '查看操作历史';
}, 'after-round');


// ── 桌面管理 ──
def('desk_add', 'desk', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  return `注册桌面: ${fp}`;
}, 'after-round');

def('desk_list', 'desk', '■', () => '列出桌面', 'after-round');

def('desk_remove', 'desk', '■', (args) => {
  const fp = (args?.filePath ?? '(?)') as string;
  return `移除桌面: ${fp}`;
}, 'after-round');

def('desk_clear', 'desk', '■', () => '清空桌面', 'after-round');

// ═════════════════════════════════════════════════════

/** 获取工具的翻译配置 */
export function getToolTranslation(toolName: string): ToolTranslation | undefined {
  return ALL_TOOLS.get(toolName);
}

/** 注册或覆写工具的翻译配置（供外部扩展用） */
export function registerTool(
  toolName: string,
  translation: ToolTranslation,
): void {
  ALL_TOOLS.set(toolName, translation);
  const oldCat = Object.entries(catMap).find(([, s]) => s.has(toolName));
  if (oldCat) oldCat[1].delete(toolName);
  catMap[translation.category]?.add(toolName);
}

/** 生成工具调用的友好标签 */
export function friendlyToolCallLabel(toolName: string, args: Record<string, unknown>): string {
  const t = ALL_TOOLS.get(toolName);
  if (t) {
    return `\x1b[94m${t.icon} ${t.callLabel(args)}\x1b[0m`;
  }
  // 未注册的工具（如 inner_skills）→ 通用 fallback
  return `\x1b[94m■\x1b[0m \x1b[30m调用 ${toolName}\x1b[0m`;
}
/** 获取工具的折叠模式 */
export function getToolCollapse(toolName: string): 'never' | 'single' | 'after-round' {
  const t = ALL_TOOLS.get(toolName);
  return t?.collapse ?? 'never';
}

/** 生成工具结果的友好摘要（按工具类型做差异化处理） */
export function friendlyToolResultLabel(
  toolName: string,
  _args: Record<string, unknown>,
  output: string,
): string {

  if (READ_TOOLS.has(toolName)) {
    return formatReadResult(output);
  }
  if (SEARCH_TOOLS.has(toolName)) {
    return formatSearchResult(toolName, output);
  }
  if (EXEC_TOOLS.has(toolName)) {
    return formatExecResult(output);
  }
  if (PATCH_TOOLS.has(toolName)) {
    return formatPatchResult(output);
  }
  // file / desk 等操作类工具的输出已经是友好的结构化消息
  return formatDefaultResult(output);
}

// ── 差异化格式化辅助函数 ──

function formatReadResult(output: string): string {
  const maxPreview = 300;
  if (output.length <= maxPreview) {
    return `● ${output}`;
  }
  const lines = output.split('\n');
  const totalLines = lines.length;
  const headCount = 5;
  const head = lines.slice(0, headCount).map(l => `  ${l}`).join('\n');
  const omitted = totalLines - headCount;
  return `● 共 ${PURPLE}${totalLines}\x1b[0m 行 / ${PURPLE}${output.length}\x1b[0m 字符\n${head}\n${BLUE_GRAY}  ... 其余 ${omitted} 行省略 ...\x1b[0m`;
}

function formatSearchResult(toolName: string, output: string): string {
  // JSON 格式的结果（search_all_file, search_sub_file, search_directory）
  if (toolName !== 'search_content') {
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          return `●  未找到匹配结果`;
        }
        const items = parsed.slice(0, 15).map((item: any) => {
          return `  ${item.name || item.path || '(unnamed)'}`;
        }).join('\n');
        const more = parsed.length > 15 ? `\n${BLUE_GRAY}  ... 还有 ${parsed.length - 15} 个结果\x1b[0m` : '';
        return `●  找到 ${PURPLE}${parsed.length}\x1b[0m 条结果\n${items}${more}`;
      }
    } catch {
      // 非 JSON 格式，降级
    }
  }

  // search_content 或其他文本格式的结果
  const lines = output.split('\n');
  if (lines.length <= 12 && output.length <= 400) {
    return `● ${output}`;
  }
  const headCount = 8;
  const head = lines.slice(0, headCount).map(l => `  ${l}`).join('\n');
  const remaining = lines.length - headCount;
  const omitSuffix = remaining > 0 ? `\n${BLUE_GRAY}  ... 还有 ${remaining} 行 ...\x1b[0m` : '';
  return `●  共 ${PURPLE}${lines.length}\x1b[0m 行匹配\n${head}${omitSuffix}`;
}

function formatExecResult(output: string): string {
  const maxPreview = 300;
  if (output.length <= maxPreview) {
    return `● ${output}`;
  }
  const lines = output.split('\n');
  const totalLines = lines.length;
  const headCount = 8;
  const head = lines.slice(0, headCount).map(l => `  ${l}`).join('\n');
  return `●  输出 ${PURPLE}${totalLines}\x1b[0m 行 / ${PURPLE}${output.length}\x1b[0m 字符\n${head}\n${BLUE_GRAY}  ... 剩余 ${totalLines - headCount} 行省略 ...\x1b[0m`;
}


function formatPatchResult(output: string): string {
  // patch 类工具（add_patch/del_patch/modify_patch/ensure_patch）
  // 的输出已经是高度结构化的自描述文本（含 ANSI diff 标记）。
  // 直接原样输出完整内容，不截断、不加冗余前缀。
  // 超大输出时做头尾保留以控制体积
  const maxLen = 6000;
  if (output.length <= maxLen) {
    return output;
  }
  const lines = output.split('\n');
  if (lines.length <= 3) {
    return output.slice(0, maxLen) + '...';
  }
  const headCount = Math.min(8, Math.max(3, Math.floor(lines.length * 0.25)));
  const tailCount = Math.min(12, Math.max(3, Math.floor(lines.length * 0.3)));
  const omitted = lines.length - headCount - tailCount;
  const head = lines.slice(0, headCount).join('\n');
  const tail = lines.slice(-tailCount).join('\n');
  return `${head}\n${BLUE_GRAY}  ... 中间 ${omitted} 行省略 ...\x1b[0m\n${tail}`;
}

function formatDefaultResult(output: string): string {
  const maxLen = 600;
  if (output.length <= maxLen) {
    return `● ${output}`;
  }
  return `● ${output.slice(0, maxLen)}...`;
}

/** 批量注册某个 skill 的所有工具翻译（供 loadInnerSkills 调用） */
export function registerSkillTranslations(
  translations: Record<string, ToolTranslation>,
): void {
  for (const [name, trans] of Object.entries(translations)) {
    registerTool(name, trans);
  }
}





