import { getToolTranslation } from './assets/tool-translations';
import { getActiveTodo, getTodos } from './tools/todo-state';
import { getPanelProviders } from './tools/panel-registry';
import { WHALE } from './assets/whale.js';

/**
 * Seek Agent - 沉浸式全屏 TUI (Terminal User Interface)
 *
 * 采用 Alternate Screen Buffer（备用屏幕缓冲区）技术，
 * 启动时进入全新的全屏界面，退出时恢复原终端历史记录。
 *
 * 布局结构（行号从 1 开始）：
 *   Row 1         ─╭══════════════════╮  头栏（Header Bar）
 *   Row 2         │  ✨ Seek Agent    │
 *   Row 3         ╰══════════════════╯
 *   Row 4 ~ N-2   消息区域（可滚动）    消息区域（Message Area）
 *   Row N-1       状态提示栏（Status Bar）
 *   Row N         ❯ 输入栏              输入栏（Input Bar）
 *
 * 特性：
 * - 进入备用屏幕，无历史记录干扰
 * - 固定底栏输入（支持左右移动、历史、编辑）
 * - 上方消息区支持鼠标滚轮滚动历史
 * - 流式追加 agent 消息
 * - ANSI 彩色渲染
 * - 窗口尺寸变化自适应
 * - 非阻塞输入（AI 处理时仍可输入）
 * - 浅色主题（白色背景）
 */

// ──────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════
// ANSI 转义码
// ═════════════════════════════════════════════════════
const CSI = '\x1b[';

const RESET_BG = CSI + '0;38;2;0;0;0;48;2;245;245;245m'; // 复位 + 黑色前景 + 白色背景
const BOLD     = CSI + '1m';
const DIM      = CSI + '2m';
const REVERSE  = CSI + '7m';
const USER_NAME = "祝景玥";
const AGENT_NAME = "小鲸鱼Deepseek";
/** 备用屏幕缓冲区切换 */
const ENTER_ALT_BUFFER = CSI + '?1049h';
const EXIT_ALT_BUFFER  = CSI + '?1049l';

/** 鼠标追踪 */
const ENABLE_MOUSE   = CSI + '?1000h' + CSI + '?1006h';
const DISABLE_MOUSE  = CSI + '?1006l' + CSI + '?1000l';

const FG = {
  black:   CSI + '30m',
  red:     CSI + '31m',
  green:   CSI + '32m',
  yellow:  CSI + '33m',
  blue:    CSI + '34m',
  magenta: CSI + '35m',
  cyan:    CSI + '36m',
  white:   CSI + '37m',
  gray:    CSI + '90m',
  lightgray: "\x1b[38;2;195;195;195m",
  darkpurple: "\x1b[38;2;110;0;130m",
  lightbluegray: "\x1b[38;2;112;128;144m",
  brightRed:     CSI + '91m',
  brightGreen:   CSI + '92m',
  brightYellow:  CSI + '93m',
  brightBlue:    CSI + '94m',
  brightMagenta: CSI + '95m',
  brightCyan:    CSI + '96m',
  brightWhite:   CSI + '97m',
};

/** 背景色（用于浅色主题） */
const BG = {
  white:   '\x1b[48;2;245;245;245m',
  default: CSI + '49m',
  softgray: '\x1b[48;2;215;215;240m'
};

function cursorTo(row: number, col: number = 1): string {
  return CSI + row + ';' + col + 'H';
}
function eraseLine(n: 0 | 1 | 2 = 2): string { return CSI + n + 'K'; }
function eraseDisplay(n: 0 | 1 | 2 = 2): string { return CSI + n + 'J'; }

const cursorHide = CSI + '?25l';
const cursorShow = CSI + '?25h';

// ═════════════════════════════════════════════════════
// 辅助函数
// ═════════════════════════════════════════════════════

function color(fg: string, text: string, bold = false): string {
  return `${bold ? BOLD : ''}${fg}${text}${RESET_BG}`;
}

/**
 * 将 ANSI 终端颜色转换为适合白底浅色主题的版本。
 * - 白色/亮白前景 → 深色（白底上白色不可见）
 * - 背景色 → 默认透明（避免覆盖 TUI 的白底）
 * - 其他颜色尽量保留但调亮，确保对比度
 */
function ansiToLightBg(s: string): string {
  // 剥离回车符，防止 \r 导致光标跳回行首覆盖字符
  s = s.replace(/\r/g, '');
  // 处理所有 ANSI CSI 序列：
  //   - SGR 颜色/样式码（以 'm' 结尾）→ 映射到白底友好版本
  //   - 其他控制序列（光标移动、清屏、hide/show 等）→ 剥离
  return s.replace(/\x1b\[[\d;<=>?]*[a-zA-Z]/g, (match: string) => {
    if (match.endsWith('m')) {
      const inner = match.slice(2, -1); // 去掉 \x1b[ 和末尾的 m
      const parts = inner.split(';').filter(Boolean);
      const mapped = parts.map(code => {
        const n = parseInt(code, 10);
        // 标准前景色 30-37
        if (n === 37) return '30';   // 白色→黑色
        // 绿色和黄色保持标准色（标准绿/棕黄在白底上清晰可见）
        // 不调亮（亮绿/亮黄在白底上几乎隐形）
        if (n === 32) return '32';   // 绿→标准绿
        if (n === 33) return '33';   // 黄→标准黄
        // 亮前景色 90-97
        if (n === 97) return '90';   // 亮白→亮黑（深灰）
        if (n === 93) return '33';   // 亮黄→标准黄（降回可见范围）
        if (n === 92) return '32';   // 亮绿→标准绿
        // 背景色 40-47, 100-107 → 默认（避免覆盖白底）
        if (n >= 40 && n <= 47) return '49';
        if (n >= 100 && n <= 107) return '49';
        // 全属性复位（\x1b[0m）→ 复位后补上白色背景 + 黑色前景，
        // 避免后续文本被终端默认背景色吞没
        if (n === 0) return '0;38;2;0;0;0;48;2;245;245;245';
        return code;
      });
      return `\x1b[${mapped.join(';')}m`;
    }
    // 非 SGR 控制序列 → 直接移除
    return '';
  });
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\[[\d;<=>?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x1b]*(?:\x1b\\|\x07)/g, '');
}
/** 获取单个字符在终端中的显示宽度（全角=2，半角=1，控制字符=0） */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code < 32) return 0;
  // CJK 范围
  if ((code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x2E80 && code <= 0x2EFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF01 && code <= 0xFF60)) return 2;
  // 几何图形（◀▶◆等）在终端中通常渲染为 1 列，排除 emoji 误判
  if (code >= 0x25A0 && code <= 0x25FF) return 1;
  // Emoji
  if (code > 0xFFFF || /\p{Extended_Pictographic}/u.test(ch)) return 2;
  return 1;
}

/** 计算字符串在终端中的实际显示宽度 */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += charWidth(ch);
  }
  return w;
}


/**
 * 从可见文本中提取结构前缀宽度（空格、竖线、bullet 等占位符字符）
 */
function structPrefixWidth(plain: string): number {
  let w = 0;
  for (const ch of plain) {
    if (/^[ │┃|•▍·]$/.test(ch)) w++;
    else break;
  }
  return w;
}

/**
 * 从含 ANSI 转义码的行中提取前 visibleChars 个可见字符对应的完整带样式前缀。
 * 续行时结构前缀由本函数提供，内容样式由 ansiWrap 的 activeStyles 追踪。
 */
function extractStyledPrefix(line: string, visibleChars: number): string {
  // eslint-disable-next-line no-control-regex
  const parts = line.split(/(\x1b\[[\d;<=>?]*[a-zA-Z]|\x1b\][^\x1b]*(?:\x1b\\|\x07))/);
  let result = '';
  let visCount = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\x1b\[/.test(p) || /^\x1b\]/.test(p)) {
      result += p;
    } else {
      for (const ch of p) {
        if (visCount >= visibleChars) break;
        result += ch;
        visCount++;
      }
      if (visCount >= visibleChars) {
        break;
      }
    }
  }

  return result;
}


/**
 * ANSI 安全的文本换行。将含有 ANSI 转义码的文本按视觉宽度换行。
 * 每次换行时，续行自动以 contPrefix 开头（已含样式），
 * 并携带换行点活跃的 ANSI 样式（如加粗/颜色），避免样式在换行处中断。
 * 每行末尾自动追加 RESET_BG 防止样式泄漏。
 */
function ansiWrap(text: string, maxWidth: number, contPrefix: string): string[] {
  const result: string[] = [];
  maxWidth = maxWidth - 6;
  const contPlainLen = contPrefix ? stripAnsi(contPrefix).length : 0;

  for (const seg of text.split('\n')) {
    // 拆成 token 流：ANSI 转义码（CSI + OSC）和 可见字符
    // eslint-disable-next-line no-control-regex
    const parts = seg.split(/(\x1b\[[\d;<=>?]*[a-zA-Z]|\x1b\][^\x1b]*(?:\x1b\\|\x07))/);
    const tokens: string[] = [];
    for (const p of parts) {
      if (/^\x1b\[/.test(p) || /^\x1b\]/.test(p)) {
        tokens.push(p);
      } else {
        for (const ch of p) tokens.push(ch);
      }
    }

    if (tokens.length === 0) { result.push(''); continue; }

    let buf = '';
    let visualLen = 0;
    // 追踪当前活跃的非重置 ANSI 样式（如颜色、粗体等），用于换行时续行恢复
    let activeStyles = '';

    for (const tok of tokens) {
      if (/^\x1b\[/.test(tok) || /^\x1b\]/.test(tok)) {
        buf += tok;
        // CSI SGR 样式追踪（OSC 超链接不影响样式）
        if (/^\x1b\[/.test(tok)) {
          if (tok === RESET_BG || /^\x1b\[0(;|m)/.test(tok) || tok === '\x1b[m') {
            activeStyles = '';
          } else {
            activeStyles += tok;
          }
        }
      } else {
        // 普通可见字符
        const chW = charWidth(tok);
        if (visualLen > 0 && visualLen + chW > maxWidth) {
          result.push(buf + RESET_BG);
          // 续行：结构前缀 + 活跃样式（保持颜色/粗体等不断）
          buf = contPrefix + activeStyles;
          visualLen = contPlainLen;
        }
        buf += tok;
        visualLen += chW;
      }
    }

    if (buf.length > 0 || result.length === 0) {
      result.push(buf);
    }
  }
  return result;
}

function getTermSize(): { width: number; height: number } {
  return {
    width:  process.stdout.columns || 80,
    height: process.stdout.rows    || 24,
  };
}

function formatTime(ms?: number): string {
  const d = ms ? new Date(ms) : new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

// 兼容旧调用（保留引用）
function timestamp(): string {
  return formatTime();
}

// ═════════════════════════════════════════════════════
// 消息类型
// ═════════════════════════════════════════════════════
export interface UIMessage {
  role: 'user' | 'agent' | 'system' | 'tool' | 'divider' | 'banner' | 'blank' | 'subagent';
  content: string;
  /** 消息创建时间戳（毫秒） */
  createdAt?: number;
  /** 子模型提交的名称（仅 subagent 角色使用） */
  subagentName?: string;
  /** 折叠状态（仅 tool 消息使用） */
  collapsed?: boolean;
  /** 工具元信息（折叠时用于渲染工具名和参数） */
  toolMeta?: { toolName: string; args: Record<string, unknown> };
  /** 标记为「不渲染」，用于移除已折叠工具的调用消息而不影响其他索引 */
  doNotRender?: boolean;
}
const HEADER_ROWS     = 3;  // 头栏占 3 行
const INPUT_BAR_ROWS  = 2;  // 底栏占 2 行（pending 提示 + 输入栏）

/** 滚轮一次滚动行数 */
const SCROLL_STEP = 3;

// ═════════════════════════════════════════════════════
// 简单的 ANSI 转义序列解析器
// 用于替代 readline.emitKeypressEvents，从而能拦截鼠标事件
// ═════════════════════════════════════════════════════

interface ParsedKey {
  str: string | null;
  key: {
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    sequence?: string;
  };
}

/**
 * 将原始输入缓冲区解析为按键或鼠标事件。
 * 返回 null 表示需要更多数据（序列不完整）。
 */
function parseInput(buf: Buffer): ParsedKey | null {
  const s = buf.toString('utf-8');

  // ── SGR 鼠标事件: ESC [ < button ; col ; row M/m ──
  const mouseRe = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
  const m = s.match(mouseRe);
  if (m) {
    const button = parseInt(m[1]);
    const press = m[4] === 'M';  // M=按下, m=释放
    // 只处理按下事件 (64=滚轮上, 65=滚轮下)
    if (press && (button === 64 || button === 65)) {
      return {
        str: null,
        key: { name: '__mouse_wheel__', ctrl: false, meta: false, shift: false, sequence: s },
      };
    }
    // 其他鼠标事件忽略
    return { str: null, key: { name: '__mouse_ignore__', sequence: s } };
  }

  // ── 控制字符 ──
  if (s.length === 1) {
    const ch = s.charCodeAt(0);
    // Enter
    if (ch === 13 || ch === 10) {
      return { str: '\r', key: { name: 'enter', sequence: s } };
    }
    // Backspace
    if (ch === 127) {
      return { str: '\x7f', key: { name: 'backspace', sequence: s } };
    }
    // Tab
    if (ch === 9) {
      return { str: '\t', key: { name: 'tab', sequence: s } };
    }
    // Escape
    if (ch === 27) {
      return { str: '\x1b', key: { name: 'escape', sequence: s } };
    }
    // Ctrl+字母
    if (ch >= 1 && ch <= 26) {
      const ctrlName = String.fromCharCode(96 + ch); // 1->a, 2->b, ...
      return { str: s, key: { name: ctrlName, ctrl: true, sequence: s } };
    }
    // 普通可打印字符
    return { str: s, key: { name: s, sequence: s } };
  }

  // ── 转义序列: CSI (ESC [ ... ) ──
  const csiRe = /^\x1b\[(.*)$/;
  const csiM = s.match(csiRe);
  if (csiM) {
    const inner = csiM[1];
    // CSI n~ 系列
    const tildeRe = /^(\d+)(?:;(\d+))?~$/;
    const tM = inner.match(tildeRe);
    if (tM) {
      const n = parseInt(tM[1]);
      const nameMap: Record<number, string> = {
        1: 'home', 2: 'insert', 3: 'delete',
        4: 'end',  5: 'pageup', 6: 'pagedown',
        7: 'home', 8: 'end',
      };
      const name = nameMap[n];
      if (name) {
        return { str: null, key: { name, sequence: s } };
      }
      return { str: null, key: { name: `f${n - 10}`, sequence: s } };
    }
    // CSI A/B/C/D/E/F/H 方向键/Home/End等
    const letterRe = /^(\d+)?(?:;(\d+))?([A-DEFH-Z])$/;
    const lM = inner.match(letterRe);
    if (lM) {
      const letter = lM[3];
      const letterMap: Record<string, string> = {
        'A': 'up', 'B': 'down', 'C': 'right', 'D': 'left',
        'E': 'begin', 'F': 'end', 'H': 'home',
      };
      const name = letterMap[letter];
      if (name) {
        return { str: null, key: { name, sequence: s } };
      }
      return { str: null, key: { name: letter.toLowerCase(), sequence: s } };
    }
    // CSI Z (Shift+Tab)
    if (inner === 'Z') {
      return { str: null, key: { name: 'tab', shift: true, sequence: s } };
    }
  }

  // ── ESC O 系列 (SS3 序列) ──
  const ss3Re = /^\x1bO([A-H])$/;
  const ss3M = s.match(ss3Re);
  if (ss3M) {
    const letter = ss3M[1];
    const map: Record<string, string> = {
      'A': 'up', 'B': 'down', 'C': 'right', 'D': 'left',
      'H': 'home', 'F': 'end',
    };
    const name = map[letter];
    if (name) return { str: null, key: { name, sequence: s } };
  }

  // ── 纯 ESC（独立） ──
  if (s === '\x1b') {
    return { str: '\x1b', key: { name: 'escape', sequence: s } };
  }

  // 未能识别的序列：以 ESC 开头的丢弃（避免终端控制序列混入输入框）
  if (s.startsWith('\x1b')) {
    return { str: null, key: { name: '__ignore__', sequence: s } };
  }
  // 其他作为普通文本返回
  return { str: s, key: { name: undefined, sequence: s } };
}



// ═════════════════════════════════════════════════════
// Markdown 渲染（终端 ANSI 样式）
// ═════════════════════════════════════════════════════

const UNDERLINE = CSI + '4m';
const ITALIC    = CSI + '3m';

/** 行内 Markdown 元素 → ANSI 转义码 */
function renderMarkdownInline(text: string): string {
  // 1. 先保护行内代码 (`` `code` ``)
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m: string, c: string) => {
    codes.push(c);
    return `\x00C${codes.length - 1}\x00`;
  });

  // 2. 粗体 **text** → 黑色粗体（在白底上清晰可见）
  s = s.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET_BG}`);

  // 3. 斜体 *text*（避免与粗体冲突）→ 黑色斜体
  s = s.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, `${FG.black}${ITALIC}$1${RESET_BG}`);

  // 4. 链接 [text](url) → 蓝色下划线
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, `${FG.blue}${UNDERLINE}$1${RESET_BG}`);

  // 5. 还原行内代码 → 灰色背景 + 黑色字
  s = s.replace(/\x00C(\d+)\x00/g, (_m: string, idx: string) => {
    return `${FG.darkpurple}${codes[parseInt(idx)]}${RESET_BG}`;
  });

  return s;
}

/** 渲染完整的 Markdown 文本为多行 ANSI 字符串（不包含行前缀） */
function renderMarkdownText(text: string): string[] {
  const result: string[] = [];
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine;

    // ── 代码块开始/结束 ──
    if (/^```/.test(trimmed)) {
      if (inCodeBlock) {
        // 结束代码块
        result.push(`${FG.lightbluegray}┌─ code ─────────────────────${RESET_BG}`);
        for (const cl of codeLines) {
          result.push(`${FG.gray}│ ${cl}${RESET_BG}`);
        }
        result.push(`${FG.lightbluegray}└────────────────────────────${RESET_BG}`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    // ── 空行 ──
    if (trimmed === '') {
      result.push('');
      continue;
    }

    // ── 标题 # ## ### ──
    const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const headingStyles = [FG.darkpurple, FG.blue, FG.brightBlue];
      const lineStyle = `${BOLD}${headingStyles[level - 1]}`;
      result.push(`${lineStyle}${renderMarkdownInline(hMatch[2])}${RESET_BG}`);
      continue;
    }

    // ── 引用 > ──
    const qMatch = trimmed.match(/^>\s*(.*)$/);
    if (qMatch) {
      result.push(`${FG.lightbluegray}▍ ${renderMarkdownInline(qMatch[1])}${RESET_BG}`);
      continue;
    }

    // ── 无序列表 - * ──
    const ulMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      result.push(`${FG.cyan}•${RESET_BG} ${renderMarkdownInline(ulMatch[1])}${RESET_BG}`);
      continue;
    }

    // ── 有序列表 1. 2. ──
    const olMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (olMatch) {
      result.push(`${FG.cyan}${olMatch[1]}.${RESET_BG} ${renderMarkdownInline(olMatch[2])}${RESET_BG}`);
      continue;
    }

    // ── 分割线 --- ──
    if (/^-{3,}$/.test(trimmed)) {
      result.push(`${DIM}${FG.gray}${'─'.repeat(40)}${RESET_BG}`);
      continue;
    }

    // ── 普通段落 ──
    result.push(renderMarkdownInline(trimmed));
  }

  // 如果代码块未闭合，强制输出
  if (inCodeBlock && codeLines.length > 0) {
    result.push(`${FG.black}┌─ code ─────────────────────${RESET_BG}`);
    for (const cl of codeLines) {
      result.push(`${FG.black}│ ${cl}${RESET_BG}`);
    }
    result.push(`${FG.black}└────────────────────────────${RESET_BG}`);
  }

  return result;
}
// ═════════════════════════════════════════════════════
// TerminalUI 主类
// ═════════════════════════════════════════════════════
export class TerminalUI {
  // ─── 输入状态 ───
  private inputBuffer = '';
  private cursorPos   = 0;
  private history: string[] = [];
  private historyIndex = -1;

  // ─── 消息 ───
  messages: UIMessage[] = [];


  // ─── 运行状态 ───
  private isProcessing = false;
  private running      = false;
  private promptText   = '';
  // ─── AI 请求中断控制 ───
  private abortController: AbortController | null = null;
  // ─── 上下文长度信息 ───
  private contextChars = 0;    // 当前上下文字符数
  private contextTokens = 0;   // 当前上下文 token 数（来自 tokenizer，0 表示未计算）
  private maxContextChars = 0; // 历史峰值
  /** 实际（非缓存）工具调用数 */
  toolCallCount = 0;

  private cachedDisplayLines: string[] = [];
  /** 思考中旋转指示器帧 */
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex = 0;
  private thinkingInterval: ReturnType<typeof setInterval> | null = null;
  private listenInterval: ReturnType<typeof setInterval> | null = null;
  private listenActiveName: string | null = null;

  // ─── 分栏布局 ───
  private msgColWidth = 0;
  private panelColWidth = 0;
  /** 面板各行内容（每次渲染时重新生成） */
  private panelLines: string[] = [];
  /** 列分隔符（带样式） */
  private readonly COL_SEP = ` ${FG.lightbluegray}│${RESET_BG} `;

  // ─── 滚动状态 ───
  private scrollOffset = 0;           // 从底部开始偏移的行数，0=最新
  private allDisplayLines: string[] = []; // 所有消息格式化后的总行列表

  // ─── 原始输入数据缓冲（用于处理分块到达的转义序列） ───
  private rawBuffer = '';

  // ─── 回调 ───
  onSubmit: ((input: string) => void) | null = null;
  onExit: (() => void) | null = null;
  /** 快捷键触发的命令回调：cmd 为命令名 */
  onCommand: ((cmd: string) => void) | null = null;

  constructor() {
    process.stdout.on('resize', () => {
      if (this.running) this.fullRedraw();
    });
    this.computeLayout();
  }

  // ═══════════════════════════════════════════════════
  // 启动 / 停止
  // ═══════════════════════════════════════════════════

  /** 启动沉浸式 TUI（白底浅色主题） */
  start(promptText = '❯ '): void {
    this.promptText = promptText;
    this.running    = true;

    // ── 进入 Alternate Screen Buffer，设置白色背景 ──
    process.stdout.write(ENTER_ALT_BUFFER + cursorHide + BG.white + eraseDisplay(2) + cursorTo(1, 1));

    // ── 启用鼠标追踪 ──
    process.stdout.write(ENABLE_MOUSE);

    // ── 绘制初始界面 ──
    this.renderHeader();
    this.fillMessageArea();
    this.renderAllFixedBars();

    // ── 设置 raw mode + 自定义数据处理器代替 readline.emitKeypressEvents ──
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', this.handleRawData);
    process.stdin.resume();

    // 开屏：显示鲸鱼字符画
    this.messages.push({ role: 'banner', content: WHALE });

    // 启动消息
    this.addSystemMessage(
      `✦ ${BOLD}Seek Agent${RESET_BG} 已启动。输入 ${color(FG.green, '/exit')} 退出，${color(FG.green, '/clear')} 清屏。滚轮可以滚动历史消息。`
    );
  }

  /** 停止 TUI，退出备用屏幕，恢复终端原样 */
  stop(): void {
    this.running = false;

    // 恢复终端
    process.stdout.write(DISABLE_MOUSE);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeListener('data', this.handleRawData);
    process.stdin.pause();

    // 退出备用屏幕缓冲，回到原来的终端历史
    process.stdout.write(BG.default + cursorShow + EXIT_ALT_BUFFER);
  }

  // ═══════════════════════════════════════════════════
  // 原始数据输入处理
  // ═══════════════════════════════════════════════════

  private handleRawData = (data: Buffer): void => {
    if (!this.running) return;

    this.rawBuffer += data.toString('utf-8');

    // 循环尝试解析完整的序列
    while (this.rawBuffer.length > 0) {
      const parsed = parseInput(Buffer.from(this.rawBuffer, 'utf-8'));
      if (parsed === null) {
        // 序列不完整，等待更多数据
        break;
      }

      // 消耗已解析的字节数
      const consumedLen = parsed.key.sequence ? parsed.key.sequence.length : 1;
      this.rawBuffer = this.rawBuffer.slice(consumedLen);

      // 处理解析结果
      if (parsed.key.name === '__mouse_wheel__') {
        const isUp = parsed.key.sequence!.includes('<64;');
        if (isUp) this.scrollUp(SCROLL_STEP);
        else this.scrollDown(SCROLL_STEP);
        continue;
      }

      if (parsed.key.name === '__mouse_ignore__') {
        continue;
      }

      this.dispatchKey(parsed);
    }
  };

  /** 将解析出的按键事件分发给对应的处理逻辑 */
  private dispatchKey(parsed: ParsedKey): void {
    const key = parsed.key;
    const str = parsed.str;

    // ─── Ctrl+C：AI 运行时中断当前轮次，否则退出 ───
    if (key.ctrl && key.name === 'c') {
      if (this.isProcessing && this.abortController) {
        this.abortController.abort();
        this.addToolMessage('■ 用户中断了 AI 处理');
        this.renderAllFixedBars();
      } else {
        this.stop();
        if (this.onExit) this.onExit();
        else process.exit(0);
      }
      return;
    }

    // ─── Ctrl+L 清屏 ───
    if (key.ctrl && key.name === 'l') {
      this.clearMessages();
      return;
    }
    // ─── Ctrl+Q 强制清理工具调用 ───
    if (key.ctrl && key.name === 'q') {
      if (this.onCommand) this.onCommand('memory_shorten');
      return;
    }

    // ─── Ctrl+S 保存会话 ───
    if (key.ctrl && key.name === 's') {
      if (this.onCommand) this.onCommand('save_session');
      return;
    }

    // ─── Ctrl+W 强制折叠 3 轮前的内容 ───
    if (key.ctrl && key.name === 'w') {
      if (this.onCommand) this.onCommand('memory_focus');
      return;
    }

    // ─── Ctrl+U 清空输入 ───
    if (key.ctrl && key.name === 'u') {
      this.inputBuffer = '';
      this.cursorPos   = 0;
      this.renderInputBar();
      return;
    }

    // ─── Ctrl+D（退出） ───
    if (key.ctrl && key.name === 'd') {
      this.stop();
      if (this.onExit) this.onExit();
      else process.exit(0);
      return;
    }
    // ─── Page Up / Page Down 滚动 ───
    if (key.name === 'pageup') {
      this.scrollUp(this.getAvailableLines());
      return;
    }
    if (key.name === 'pagedown') {
      this.scrollDown(this.getAvailableLines());
      return;
    }

    // ─── 上下箭头 - 历史浏览 ───
    if (key.name === 'up' && !key.ctrl) {
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.inputBuffer = this.history[this.historyIndex];
        this.cursorPos   = this.inputBuffer.length;
      }
      this.renderInputBar();
      return;
    }
    if (key.name === 'down' && !key.ctrl) {
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++;
        this.inputBuffer = this.history[this.historyIndex];
        this.cursorPos   = this.inputBuffer.length;
      } else {
        this.historyIndex = this.history.length;
        this.inputBuffer  = '';
        this.cursorPos    = 0;
      }
      this.renderInputBar();
      return;
    }

    if (key.name === 'left') {
      if (this.cursorPos > 0) this.cursorPos--;
      this.renderInputBar();
      return;
    }
    if (key.name === 'right') {
      if (this.cursorPos < this.inputBuffer.length) this.cursorPos++;
      this.renderInputBar();
      return;
    }

    if (key.name === 'home') {
      this.cursorPos = 0;
      this.renderInputBar();
      return;
    }
    if (key.name === 'end') {
      this.cursorPos = this.inputBuffer.length;
      this.renderInputBar();
      return;
    }

    // ─── Enter ───
    if (key.name === 'enter' || key.name === 'return') {
      const input = this.inputBuffer.trim();
      if (!input) {
        this.renderInputBar();
        return;
      }

      if (this.isProcessing) {
        this.inputBuffer = '';
        this.cursorPos   = 0;
        this.renderInputBar();
        if (this.onSubmit) Promise.resolve(this.onSubmit(input)).catch(() => {});
      } else {
        this.history.push(input);
        this.historyIndex = this.history.length;
        this.renderInputBar();
        if (this.onSubmit) Promise.resolve(this.onSubmit(input)).catch(() => {});
      }
      return;
    }

    if (key.name === 'backspace') {
      if (this.cursorPos > 0) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos - 1) +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos--;
      }
      this.renderInputBar();
      return;
    }

    if (key.name === 'delete') {
      if (this.cursorPos < this.inputBuffer.length) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          this.inputBuffer.slice(this.cursorPos + 1);
      }
      this.renderInputBar();
      return;
    }

    // ─── Tab / Ctrl+I 强制中断所有子 agent ───
    if (key.name === 'tab') {
      if (this.onCommand) this.onCommand('interrupt_agents');
      return;
    }
    if (key.name === 'escape') {
      return;
    }

    if (str && !key.ctrl && !key.meta && !key.name?.startsWith('__')) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.cursorPos) +
        str +
        this.inputBuffer.slice(this.cursorPos);
      this.cursorPos += str.length;
      this.historyIndex = this.history.length;
      this.renderInputBar();
    }
  }

  // ═══════════════════════════════════════════════════
  // 滚动控制
  // ═══════════════════════════════════════════════════

  private scrollUp(step: number): void {
    const maxOffset = Math.max(0, this.allDisplayLines.length - this.getAvailableLines());
    this.scrollOffset = Math.min(maxOffset, this.scrollOffset + step);
    this.renderMessageArea();
    this.renderAllFixedBars();
  }

  private scrollDown(step: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - step);
    this.renderMessageArea();
    this.renderAllFixedBars();
  }

  private resetScroll(): void {
    this.scrollOffset = 0;
  }

  private isAtBottom(): boolean {
    return this.scrollOffset === 0;
  }

  // ═══════════════════════════════════════════════════
  // 消息添加
  // ═══════════════════════════════════════════════════

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content, createdAt: Date.now() });
    this.inputBuffer = '';
    this.cursorPos   = 0;
    this.resetScroll();
    this.refreshDisplay();
  }


  addSubAgentMessage(name: string, content: string): void {
    // 同源拼接：如果最后一条 subagent 消息也是同一名子模型，追加内容
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'subagent' && last.subagentName === name) {
      last.content += `\n\n---\n${content}`;
    } else {
      this.messages.push({ role: 'subagent', content, subagentName: name, createdAt: Date.now() });
    }
    this.inputBuffer = '';
    this.cursorPos   = 0;
    this.resetScroll();
    this.refreshDisplay();
  }
  addAgentMessage(content: string): void {
    this.messages.push({ role: 'agent', content, createdAt: Date.now() });
    this.resetScroll();
    this.refreshDisplay();
  }

  addToolMessage(content: string, toolMeta?: { toolName: string; args: Record<string, unknown> }, _fullOutput?: string): void {
    this.messages.push({ role: 'tool', content, toolMeta, createdAt: Date.now() });
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.refreshDisplay();
  }

  /** 批量折叠指定工具消息（轮后折叠）
   * 将消息标记为折叠态，折叠时一并标记前面的「调用中」消息为不渲染，
   * 避免同一工具的名称+参数显示两遍。
   * 使用 doNotRender 标记而非 splice 删除，避免破坏缓存的 msgIndex 引用。 */
  collapseToolMessages(entries: Array<{ msgIndex: number; toolName: string; args: Record<string, unknown> }>): void {
    for (const entry of entries) {
      const msg = this.messages[entry.msgIndex];
      if (msg && msg.role === 'tool') {
        msg.collapsed = true;
        msg.toolMeta = { toolName: entry.toolName, args: entry.args };
      }
      // 标记紧挨在前面的「调用中」消息为不渲染，避免重显示
      const callIdx = entry.msgIndex - 1;
      if (callIdx >= 0) {
        const callMsg = this.messages[callIdx];
        if (callMsg && callMsg.role === 'tool' && !callMsg.toolMeta) {
          callMsg.doNotRender = true;
        }
      }
    }
    this.refreshDisplay();
  }

  addDivider(): void {
    this.messages.push({ role: 'divider', content: '' });
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.refreshDisplay();
  }

  addBlankLine(): void {
    this.messages.push({ role: 'blank', content: '' });
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.refreshDisplay();
  }

  addSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content, createdAt: Date.now() });
    if (this.isAtBottom()) this.scrollOffset = 0;
    this.refreshDisplay();
  }


  appendToLastAgent(text: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'agent') {
        this.messages[i].content += text;
        break;
      }
    }
    this.refreshDisplay();
  }

  removeLastAgent(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'agent') {
        this.messages.splice(i, 1);
        break;
      }
    }
    this.refreshDisplay();
  }

  // ═══════════════════════════════════════════════════
  // 非阻塞输入
  // ═══════════════════════════════════════════════════

  setProcessing(processing: boolean): void {
    this.isProcessing = processing;
    if (!processing) {
      this.abortController = null;
    }
    this.renderAllFixedBars();
  }

  /** 启动思考中旋转指示器动画 */
  startThinkingSpinner(): void {
    if (this.thinkingInterval) return;
    this.spinnerIndex = 0;
    this.thinkingInterval = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      this.refreshDisplay();
    }, 120);
  }

  /** 停止思考中旋转指示器动画 */
  stopThinkingSpinner(): void {
    if (this.thinkingInterval) {
      clearInterval(this.thinkingInterval);
      this.thinkingInterval = null;
    }
  }

  /** 创建一个新的 AbortController 用于中断当前 AI 请求 */

  /** 启动审查中旋转指示器动画 */
  showListenStatus(name: string): void {
    this.listenActiveName = name;
    if (!this.listenInterval) {
      this.listenInterval = setInterval(() => {
        this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
        this.refreshDisplay();
      }, 120);
    }
    this.refreshDisplay();
  }

  /** 停止审查中旋转指示器动画 */
  hideListenStatus(): void {
    this.listenActiveName = null;
    if (this.listenInterval) {
      clearInterval(this.listenInterval);
      this.listenInterval = null;
    }
    this.refreshDisplay();
  }
  createAbortController(): AbortController {
    this.abortController = new AbortController();
    return this.abortController;
  }

  /** 获取当前中断信号 */
  get abortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /** 检查当前是否已被中断 */
  get isAborted(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }


  clearMessages(): void {
    this.messages = [];
    this.cachedDisplayLines = [];
    this.allDisplayLines = [];
    this.scrollOffset = 0;
    this.resetContextLength();
    this.addBlankLine();
  }

  /** 批量替换消息列表（用于加载会话时恢复显示，不额外添加空行） */
  replaceMessages(msgs: UIMessage[]): void {
    this.messages = msgs;
    this.cachedDisplayLines = [];
    this.allDisplayLines = [];
    this.scrollOffset = 0;
    this.refreshDisplay();
  }

  getCurrentInput(): string {
    return this.inputBuffer;
  }

  /** 设置当前上下文长度（用于标题栏显示）
   * @param chars 字符数
   * @param tokens token 数（可选，0 表示未知）
   */
  setContextLength(chars: number, tokens: number = 0): void {
    this.contextChars = chars;
    this.contextTokens = tokens;
    if (chars > this.maxContextChars) this.maxContextChars = chars;
    if (this.running) this.renderHeader();
  }

  /** 重置上下文长度统计 */
  resetContextLength(): void {
    this.contextChars = 0;
    this.contextTokens = 0;
    this.maxContextChars = 0;
  }


  /** 设置实际工具调用计数（由 agent 更新，排除缓存命中） */
  setToolCallCount(n: number): void {
    this.toolCallCount = n;
    if (this.running) this.refreshDisplay();
  }

  setInput(text: string): void {
    this.inputBuffer = text;
    this.cursorPos   = text.length;
    this.renderAllFixedBars();
  }

  // ═══════════════════════════════════════════════════
  // 核心渲染
  // ═══════════════════════════════════════════════════

  /** 根据当前终端宽度计算分栏宽度（左 2/3，右 1/3）
   *  需扣除 3 列分隔符（COL_SEP），避免 composeRow 溢出终端
   */
  private computeLayout(): void {
    const w = getTermSize().width;
    const sepW = 3; // ' │ ' 的可见宽度
    const avail = w - sepW;
    this.msgColWidth = Math.floor(avail * 2 / 3);
    this.panelColWidth = avail - this.msgColWidth;
    // 终端过窄时退化：至少保留 MIN_MSG_WIDTH 列给消息
    const MIN_MSG = 30;
    if (this.msgColWidth < MIN_MSG) {
      this.msgColWidth = w;
      this.panelColWidth = 0;
    }
  }

  private fullRedraw(): void {
    if (!this.running) return;
    this.computeLayout();
    process.stdout.write(BG.white + eraseDisplay(2) + cursorTo(1, 1));
    this.renderHeader();
    this.fillMessageArea();
    this.cachedDisplayLines = [];
    this.allDisplayLines = [];
    this.refreshDisplay();
    this.renderAllFixedBars();
  }

  /** 渲染顶栏（固定 3 行，带圆角框）
   *  底部分隔线在分栏处用 ┬ 标记左右分割 */
  private renderHeader(): void {
    const ts    = getTermSize();
    const w     = ts.width;
    const inner = w - 2;
    const sep   = '─'.repeat(Math.max(2, inner));

    const titleText  = `${BOLD}${FG.black}✨ Seek Agent${RESET_BG}`;

    // 上下文长度指示
    let ctxText = '';
    if (this.contextChars > 0) {
      const displayChars = this.contextChars >= 10000
        ? `${(this.contextChars / 1000).toFixed(1)}k`
        : `${this.contextChars}`;
      const maxDisplay = this.maxContextChars >= 10000
        ? `${(this.maxContextChars / 1000).toFixed(1)}k`
        : `${this.maxContextChars}`;

      if (this.contextTokens > 0) {
        ctxText = `${DIM}${FG.gray}ctx: ${this.contextTokens}t / max: ${maxDisplay}ch${RESET_BG}`;
      } else {
        ctxText = `${DIM}${FG.gray}ctx: ${displayChars}ch / max: ${maxDisplay}ch${RESET_BG}`;
      }
    } else {
      ctxText = `${DIM}${FG.gray}ctx: --${RESET_BG}`;
    }

    const titlePlain = stripAnsi(titleText);
    const ctxPlain   = stripAnsi(ctxText);
    const padding    = Math.max(1, inner - visibleWidth(titlePlain) - visibleWidth(ctxPlain) - 2);

    // 底部边框：在分栏位置插入 ┬
    let bottomLine: string;
    if (this.panelColWidth > 0 && this.msgColWidth > 2) {
      const leftDashes  = this.msgColWidth;
      const rightDashes = this.panelColWidth; // panelColWidth 已扣除分隔符
      bottomLine = `${FG.cyan}╰${'─'.repeat(leftDashes)}┬${'─'.repeat(rightDashes)}╯${RESET_BG}`;
    } else {
      bottomLine = `${FG.cyan}╰${sep}╯${RESET_BG}`;
    }

    const buf =
      cursorTo(1, 1) + BG.white +
      `${FG.cyan}╭${sep}╮${RESET_BG}\n` +
      `│ ${titleText}${' '.repeat(padding)}${ctxText} │\n` +
      bottomLine;

    process.stdout.write(buf);
  }

  private fillMessageArea(): void {
    const ts      = getTermSize();
    const msgRows = ts.height - HEADER_ROWS - INPUT_BAR_ROWS;
    let buf = '';
    for (let r = 0; r < msgRows; r++) {
      buf += cursorTo(HEADER_ROWS + 1 + r, 1) + BG.white + eraseLine(2);
    }
    process.stdout.write(buf);
  }

  private getAvailableLines(): number {
    const ts = getTermSize();
    return Math.max(1, ts.height - HEADER_ROWS - INPUT_BAR_ROWS);
  }

  /** 格式化一条消息为多行（浅色主题，使用 msgColWidth 宽度） */
  private formatMessage(msg: UIMessage, isToolContinuation = false): string[] {
    const lines: string[] = [];
    const width = this.msgColWidth;

    switch (msg.role) {
      case 'divider': {
        lines.push('');
        lines.push(FG.lightbluegray + '─'.repeat(Math.max(2, width - 2)) + RESET_BG);
        lines.push('');
        break;
      }
      case 'blank': {
        lines.push('');
        break;
      }

      case 'user': {
        const title = '    ' + FG.cyan + USER_NAME + RESET_BG + ' ' + DIM + FG.black + formatTime(msg.createdAt) + RESET_BG + ' ' + FG.cyan + '|' + RESET_BG;
        const sep = '  ' + FG.cyan + '╰╕' + '═'.repeat(visibleWidth(USER_NAME + formatTime(msg.createdAt)) + 2) + '╯' + RESET_BG;
        const contentPairs: Array<{ body: string; indicator: string }> = [];
        const rawLines = msg.content.split('\n');
        for (let ci = 0; ci < rawLines.length; ci++) {
          const indicator = ci === 0 ? ` ${FG.cyan}◀${RESET_BG}` : '';
          contentPairs.push({
            body: `    ${FG.black}${rawLines[ci]}${RESET_BG}`,
            indicator,
          });
        }

        // 所有行统一右对齐到同一基线，基线整体左移 7
        // 先对超长行做软换行，避免右对齐时 repeat(负数) 崩溃
        const allLines: string[] = [title, sep];
        for (const { body, indicator } of contentPairs) {
          const fullLine = body + indicator;
          if (visibleWidth(stripAnsi(fullLine)) <= width) {
            allLines.push(fullLine);
          } else {
            // 对 body 部分换行，指示符仅附加到最后一行末尾
            const indW = indicator ? visibleWidth(stripAnsi(indicator)) : 0;
            const wrapW = Math.max(10, width - indW);
            const wrapped = ansiWrap(body, wrapW, '    ');
            for (let wi = 0; wi < wrapped.length; wi++) {
              allLines.push(wrapped[wi] + (wi === wrapped.length - 1 ? indicator : ''));
            }
          }
        }

        const maxW = Math.min(width,
          Math.max(...allLines.map(l => visibleWidth(stripAnsi(l)))),
        );
        const basePad = Math.max(0, width - maxW - 7);
        for (const raw of allLines) {
          const lineW = visibleWidth(stripAnsi(raw));
          const extra = maxW - lineW;
          const pad = Math.max(0, basePad + extra); // 安全钳位，防 repeat(负数)
          lines.push(`${' '.repeat(pad)}${raw}`);
        }
        break;
      }
      case 'subagent': {
        const sname = msg.subagentName ?? '(子模型)';
        const title = '    ' + FG.green + sname + RESET_BG + ' ' + DIM + FG.black + formatTime(msg.createdAt) + RESET_BG + ' ' + FG.green + '|' + RESET_BG;
        const sep = '  ' + FG.green + '╰═' + '═'.repeat(visibleWidth(sname + formatTime(msg.createdAt)) + 2) + '╯' + RESET_BG;
        // 内容和指示符构建（指示符在右侧，与 user 风格一致）
        const contentPairs: Array<{ body: string; indicator: string }> = [];
        const mdLines = renderMarkdownText(msg.content);
        for (let ci = 0; ci < mdLines.length; ci++) {
          const indicator = ci === 0 ? ` ${FG.green}◀${RESET_BG}` : '';
          contentPairs.push({
            body: `    ${mdLines[ci]}${RESET_BG}`,
            indicator,
          });
        }
        // 同 user 消息一样右对齐
        const allLines: string[] = [title, sep];
        for (const { body, indicator } of contentPairs) {
          const fullLine = body + indicator;
          if (visibleWidth(stripAnsi(fullLine)) <= width) {
            allLines.push(fullLine);
          } else {
            const indW = indicator ? visibleWidth(stripAnsi(indicator)) : 0;
            const wrapW = Math.max(10, width - indW);
            const wrapped = ansiWrap(body, wrapW, '    ');
            for (let wi = 0; wi < wrapped.length; wi++) {
              allLines.push(wrapped[wi] + (wi === wrapped.length - 1 ? indicator : ''));
            }
          }
        }
        const maxW = Math.min(width,
          Math.max(...allLines.map(l => visibleWidth(stripAnsi(l)))),
        );
        const basePad = Math.max(0, width - maxW - 7);
        for (const raw of allLines) {
          const lineW = visibleWidth(stripAnsi(raw));
          const extra = maxW - lineW;
          const pad = Math.max(0, basePad + extra);
          lines.push(`${' '.repeat(pad)}${raw}`);
        }
        lines.push('');
        break;
      }
      case 'agent': {
        // 第一行开头带▶，后续内容行无指示符
        const title = '    ' + FG.blue + '│ ' + BOLD + AGENT_NAME + RESET_BG + ' ' + DIM + FG.black + formatTime(msg.createdAt) + RESET_BG;
        lines.push(title);
        lines.push('    ' + FG.blue + '╰' + '═'.repeat(visibleWidth(AGENT_NAME + formatTime(msg.createdAt)) + 2) + '╯' + RESET_BG);
        if (!msg.content || msg.content.trim() === '') {
          // 空内容表示 AI 正在思考/生成中，显示思考指示器
          lines.push(`    ${FG.blue}${this.spinnerFrames[this.spinnerIndex]}${RESET_BG} ${FG.lightbluegray}思考中${RESET_BG}`);
          lines.push('');
        } else {
          const mdLines = renderMarkdownText(msg.content);
          for (let ci = 0; ci < mdLines.length; ci++) {
            const indicator = ci === 0 ? `${FG.blue}▶${RESET_BG} ` : '  ';
            lines.push(`    ${indicator}${mdLines[ci]}${RESET_BG}`);
          }
        }
        lines.push("")
        break;
      }
      case 'tool': {
        // ── 折叠态：仅显示工具名和参数 ──
        if (msg.collapsed && msg.toolMeta) {
          const t = getToolTranslation(msg.toolMeta.toolName);
          const tcVisLen = 4 + visibleWidth('╭─ TOOLCALL ');
          const dashCount = Math.max(0, width - tcVisLen);
          lines.push(`    ${FG.blue}╭─ TOOLCALL ${'─'.repeat(dashCount-6)}${RESET_BG}`);
          if (t) {
            const label = `${t.icon} ${t.callLabel(msg.toolMeta.args)}`;
            const styledLabel = ansiToLightBg(label);
            lines.push(`    ${FG.blue}┃ ${RESET_BG}${FG.lightbluegray}${BOLD}${styledLabel}${RESET_BG} ${FG.green}[+]${RESET_BG}`);
          } else {
            lines.push(`    ${FG.blue}┃ ${RESET_BG}${FG.lightbluegray}${BOLD}[+] ${msg.toolMeta.toolName}${RESET_BG}`);
          }
          // 折叠工具也用 ╰─ 收尾
          const closeVisLen = 4 + visibleWidth('╰─ ');
          const closeDashCount = Math.max(0, width - closeVisLen);
          lines.push(`    ${FG.blue}╰─${'─'.repeat(closeDashCount-5)}${RESET_BG}`);
          break;
        }
        // ── 非折叠态：调用与结果分别显示独立标题
        if (!isToolContinuation) {
          const tcVisLen = 4 + visibleWidth('╭─ TOOLCALL ');
          const dashCount = Math.max(0, width - tcVisLen);
          lines.push(`    ${FG.blue}╭─ TOOLCALL ${'─'.repeat(dashCount-6)}${RESET_BG}`);
        } else {
          // 续行结果：以右侧分叉竖线开头，显示 RESULT 标题
          const resultVisLen = 4 + visibleWidth('├─ RESULT ');
          const dashCount = Math.max(0, width - resultVisLen);
          lines.push(`    ${FG.blue}├─ RESULT ${'─'.repeat(dashCount-6)}${RESET_BG}`);
        }
        const contentLines = msg.content.split('\n');
        for (let i = 0; i < contentLines.length; i++) {
          const cl = contentLines[i];
          // 将命令输出中的 ANSI 颜色映射为白底友好版本
          const styled = ansiToLightBg(cl);
          if (i === 0) {
            // 首行：续行结果用 │（与 ├ 衔接），调用用 ┃
            const prefix = isToolContinuation ? '│' : '┃';
            lines.push(`    ${FG.blue}${prefix} ${RESET_BG}${FG.gray}${BOLD}${styled}${RESET_BG}`);
          } else {
            // 续行：输出内容保留 ANSI 颜色（已映射到浅色主题），基色调整为灰色
            lines.push(`    ${FG.gray}│ ${RESET_BG}${FG.gray}${styled}${RESET_BG}`);
          }
        }
        // 若为结果消息（续行），用 ╰─ 闭合该工具调用块
        if (isToolContinuation) {
          const closeVisLen = 4 + visibleWidth('╰─ ');
          const dashCount = Math.max(0, width - closeVisLen);
          lines.push(`    ${FG.blue}╰─${'─'.repeat(dashCount-5)}${RESET_BG}`);
        }
        break;
      }
      case 'system': {
        for (const cl of msg.content.split('\n')) {
          lines.push(`${DIM}${FG.black}  ${cl}${RESET_BG}`);
          lines.push('')
        }
        break;
      }
      case 'banner': {
        for (const cl of msg.content.split('\n')) {
          lines.push(`  ${FG.brightBlue}${cl}${RESET_BG}`);
        }
        break;
      }
    }

    // 软换行处理（ANSI 安全，保留续行结构前缀）
    const wrapped: string[] = [];
    for (const line of lines) {
      const plain = stripAnsi(line);
      if (visibleWidth(plain) <= width) {
        wrapped.push(line);
        continue;
      }
      // 提取结构前缀宽度
      const sw = structPrefixWidth(plain);
      // 将结构前缀后的分隔空格也纳入续行前缀，保持缩进一致
      let prefixChars = sw;
      if (prefixChars < plain.length && plain[prefixChars] === ' ') {
        prefixChars++;
      }
      const contentWidth = Math.max(8, width - sw);
      if (contentWidth <= 0) { wrapped.push(line); continue; }
      // 从原文提取带完整样式的结构前缀作为续行前缀
      const contPrefix = extractStyledPrefix(line, prefixChars);
      const segs = ansiWrap(line, width, contPrefix);
      wrapped.push(...segs);
    }
    return wrapped;
  }

  private refreshDisplay(): void {
    if (!this.running) return;

    this.computeLayout();
    this.allDisplayLines = [];
    let nextToolContinuation = false;
    for (const msg of this.messages) {
      if (msg.doNotRender) continue; // 跳过已折叠工具的调用消息

      if (msg.role === 'tool' && !(msg.collapsed && msg.toolMeta)) {
        // 非折叠 tool 消息：交替显示头部/续行
        this.allDisplayLines.push(...this.formatMessage(msg, nextToolContinuation));
        nextToolContinuation = !nextToolContinuation;
      } else {
        // 非 tool 或已折叠消息：正常渲染，重置交替状态
        this.allDisplayLines.push(...this.formatMessage(msg, false));
        nextToolContinuation = false;
      }
    }
    // ── 限制渲染行数 —— 只保留最近的 4000 行 ──
    const MAX_RENDER_LINES = 4000;
    if (this.allDisplayLines.length > MAX_RENDER_LINES) {
      this.allDisplayLines = this.allDisplayLines.slice(-MAX_RENDER_LINES);
    }
    // ── 审查中指示器（类似思考中，不操作消息列表） ──
    if (this.listenActiveName) {
      this.allDisplayLines.push(`    ${FG.blue}${this.spinnerFrames[this.spinnerIndex]}${RESET_BG} ${FG.lightbluegray}${this.listenActiveName} 审查中${RESET_BG}`);
    }
    this.renderMessageArea();
    this.renderAllFixedBars();
  }

  private renderMessageArea(): void {
    const out      = process.stdout;
    const maxLines = this.getAvailableLines();
    const ts       = getTermSize();
    const startRow = HEADER_ROWS + 1;

    const total = this.allDisplayLines.length;
    const endIdx   = total - this.scrollOffset;
    const startIdx = Math.max(0, endIdx - maxLines);

    let visibleLines = this.allDisplayLines.slice(startIdx, endIdx);

    if (this.scrollOffset > 0) {
      const pct = total - maxLines > 0
        ? Math.round((this.scrollOffset / (total - maxLines)) * 100)
        : 0;
      const hint = `${DIM}${FG.black}↑ 已滚动 ${this.scrollOffset}/${total - maxLines} (${pct}%) ↑${RESET_BG}`;
      visibleLines = [hint, ...visibleLines.slice(0, maxLines - 1)];
    }

    // ── 生成面板内容 ──
    this.panelLines = this.generatePanelContent();

    // ── 逐行渲染：左列消息 + 分隔符 + 右列面板 ──
    const newCache: string[] = [];
    let buf = '';
    for (let i = 0; i < maxLines; i++) {
      const row = startRow + i;
      if (row > ts.height - INPUT_BAR_ROWS) break;

      // 左列
      const left = i < visibleLines.length ? visibleLines[i] : '';
      // 右列
      const right = i < this.panelLines.length ? this.panelLines[i] : '';

      // 组合成全宽行
      const combined = this.composeRow(left, right);
      const combinedPlain = combined ? stripAnsi(combined) : '';

      const oldLine = i < this.cachedDisplayLines.length ? this.cachedDisplayLines[i] : '';

      if (combinedPlain !== oldLine) {
        // 直接覆写整行：composeRow 已保证输出补齐到终端全宽，无需 eraseLine
        // eraseLine(2) 在 Windows Terminal 上会渲染「空白帧」导致闪烁
        buf += cursorTo(row, 1) + BG.white;
        if (combined) {
          buf += combined;
        } else {
          buf += ' '.repeat(ts.width);
        }
      }

      newCache.push(combinedPlain);
    }

    this.cachedDisplayLines = newCache;

    // 如果面板行数超过可用行数，用空白覆写超出的行
    for (let i = maxLines; i < this.cachedDisplayLines.length; i++) {
      const row = startRow + i;
      if (row > ts.height - INPUT_BAR_ROWS) break;
      buf += cursorTo(row, 1) + BG.white + ' '.repeat(ts.width);
    }

    // 一次写入所有变更，避免逐行写入导致闪烁
    if (buf) out.write(buf);
  }

  /** 将左列消息行 + 右列面板行组合为一行（含分隔符）
   *  窄终端（panelColWidth === 0）时退化到全宽消息
   */
  private composeRow(left: string, right: string): string {
    if (this.panelColWidth <= 0) return left;

    const leftPlain = left ? stripAnsi(left) : '';
    const rightPlain = right ? stripAnsi(right) : '';

    // 左列补齐到 msgColWidth
    let leftPart: string;
    const lw = visibleWidth(leftPlain);
    if (lw < this.msgColWidth) {
      const pad = this.msgColWidth - lw;
      leftPart = left ? `${left}${' '.repeat(pad)}` : ' '.repeat(this.msgColWidth);
    } else if (lw === this.msgColWidth) {
      leftPart = left || ' '.repeat(this.msgColWidth);
    } else {
      // 溢出保护：截断到 msgColWidth，防止全角字符推偏分隔符
      leftPart = extractStyledPrefix(left || '', this.msgColWidth);
    }

    // 右列补齐到 panelColWidth（使用 visibleWidth 兼容 CJK）
    let rightPart: string;
    const rw = visibleWidth(rightPlain);
    if (rw < this.panelColWidth) {
      const pad = this.panelColWidth - rw;
      rightPart = right ? `${right}${' '.repeat(pad)}` : ' '.repeat(this.panelColWidth);
    } else {
      rightPart = right || ' '.repeat(this.panelColWidth);
    }

    return `${leftPart}${this.COL_SEP}${rightPart}`;
  }

  /** 生成信息面板内容（每次渲染时重新构建）
   *  返回逐行字符串，每行宽度适配 panelColWidth */
  private generatePanelContent(): string[] {
    if (this.panelColWidth <= 0) return [];
    const pw = this.panelColWidth;
    const lines: string[] = [];

    // ── 面板标题框 ──
    const title = ' 信息面板 ';
    const titleW = visibleWidth(title);
    const leftDash = Math.max(2, Math.floor((pw - 2 - titleW) / 2) - 1);
    const rightDash = pw - 2 - leftDash - titleW;
    lines.push(`${FG.lightbluegray}╭${'─'.repeat(leftDash)}${RESET_BG}${BOLD}${FG.darkpurple}${title}${RESET_BG}${FG.lightbluegray}${'─'.repeat(rightDash)}╮${RESET_BG}`);
    lines.push(`${FG.lightbluegray}│${RESET_BG}${' '.repeat(pw - 2)}${FG.lightbluegray}│${RESET_BG}`);

    // ── 消息统计 ──
    const userCount = this.messages.filter(m => m.role === 'user').length;
    const agentCount = this.messages.filter(m => m.role === 'agent').length;
    const toolCount = this.toolCallCount;
    const totalCount = this.messages.length;

    lines.push(this.panelLine(pw, `${FG.gray}消息${RESET_BG}    ${FG.black}${totalCount}${RESET_BG}`));
    lines.push(this.panelLine(pw, `  ${FG.gray}用户${RESET_BG}    ${FG.black}${userCount}${RESET_BG}`));
    lines.push(this.panelLine(pw, `  ${FG.gray}助手${RESET_BG}    ${FG.black}${agentCount}${RESET_BG}`));
    lines.push(this.panelLine(pw, `  ${FG.gray}工具调用${RESET_BG}  ${FG.black}${toolCount}${RESET_BG}`));
    lines.push(`${FG.lightbluegray}│${RESET_BG}${' '.repeat(pw - 2)}${FG.lightbluegray}│${RESET_BG}`);

    // ── 上下文信息 ──
    if (this.contextChars > 0) {
      const ctxStr = this.contextChars >= 10000
        ? `${(this.contextChars / 1000).toFixed(1)}k`
        : `${this.contextChars}`;
      lines.push(this.panelLine(pw, `${FG.gray}上下文${RESET_BG}  ${FG.black}${ctxStr} 字符${RESET_BG}`));
    }

    // ── 状态 ──
    const statusDot = this.isProcessing ? `${FG.green}●${RESET_BG}` : `${FG.cyan}●${RESET_BG}`;
    const statusText = this.isProcessing ? '处理中' : '空闲';
    lines.push(this.panelLine(pw, `${FG.gray}状态${RESET_BG}    ${statusDot} ${FG.black}${statusText}${RESET_BG}`));

    // ── 活跃 todo 当前步骤 ──
    const activeName = getActiveTodo();
    if (activeName) {
      const todos = getTodos();
      const activeTodo_ = todos.find(t => t.name === activeName);
      if (activeTodo_) {
        const nextStep = activeTodo_.steps.find(s => !s.completed);
        if (nextStep) {
          const stepNum = activeTodo_.steps.indexOf(nextStep) + 1;
          lines.push(this.panelLine(pw, `${FG.brightBlue}正在完成${RESET_BG} ${FG.brightBlue}${nextStep.content}${RESET_BG}`));
          lines.push(this.panelLine(pw, `  ${FG.gray}进度${RESET_BG}  ${FG.brightMagenta}${stepNum}/${activeTodo_.steps.length}${RESET_BG}`));
        }
      }
    }

    // ── 时间 ──
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
    lines.push(this.panelLine(pw, `${FG.gray}时间${RESET_BG}    ${FG.black}${timeStr}${RESET_BG}`));

    // ── 第三方面板提供者 ──
    const panelProviders = getPanelProviders();
    for (const prov of panelProviders) {
      try {
        const rendered = prov.render(pw);
        if (rendered && rendered.length > 0) {
          lines.push(`${FG.lightbluegray}│${RESET_BG}${' '.repeat(pw - 2)}${FG.lightbluegray}│${RESET_BG}`);
          lines.push(...rendered);
        }
      } catch {
        // 单个提供者渲染失败不影响其他
      }
    }

    // ── 底部边框 ──
    lines.push(`${FG.lightbluegray}│${RESET_BG}${' '.repeat(pw - 2)}${FG.lightbluegray}│${RESET_BG}`);
    lines.push(`${FG.lightbluegray}╰${'─'.repeat(pw - 2)}╯${RESET_BG}`);

    return lines;
  }

  /** 生成面板中的一行内容（带左右边框，内容居左） */
  private panelLine(pw: number, content: string): string {
    const plain = stripAnsi(content);
    const pad = Math.max(0, pw - 4 - visibleWidth(plain));
    return `${FG.lightbluegray}│${RESET_BG} ${content}${' '.repeat(pad)} ${FG.lightbluegray}│${RESET_BG}`;
  }

  private renderAllFixedBars(): void {
    // renderPendingBar 和 renderInputBar 各自内部已做 eraseLine(2)，无需预擦除
    this.renderPendingBar();
    this.renderInputBar();
  }

  /** 渲染状态提示栏（倒数第二行） */
  private renderPendingBar(): void {
    const out = process.stdout;
    const ts  = getTermSize();
    const row = ts.height - 1;

    let text: string;
    if (this.isProcessing) {
      text = `${FG.lightbluegray}    处理中，按${REVERSE} Ctrl+C ${RESET_BG}${FG.lightbluegray}终止当前工作。${RESET_BG}`;
    } else {
      text = '';
    }

    out.write(cursorTo(row, 1) + BG.white + text + eraseLine(0));
  }

  /** 渲染输入栏（始终在终端最后一行） */
  private renderInputBar(): void {
    const out = process.stdout;
    const ts  = getTermSize();
    const row = ts.height;

    const prompt = this.isProcessing
      ? `${FG.green}⟳${RESET_BG} `
      : `${FG.cyan}${this.promptText}${RESET_BG}`;


    const promptLen = stripAnsi(prompt).length;
    const bufLen    = this.inputBuffer.length;

    // 过滤输入中的换行符，避免粘贴多行文本导致终端换行
    const displayBuf = this.inputBuffer.replace(/\n/g, '¶');

    const maxLen    = ts.width - 2 - promptLen - 2; // 留 2 位给省略号 + 1 位安全边界

    // ── 纯文本滑动窗口：让光标始终可见 ──
    let start = 0;
    if (bufLen > maxLen) {
      // 保持光标在窗口右侧约 1/3 处
      start = Math.max(0, Math.min(bufLen - maxLen, this.cursorPos - Math.floor(maxLen * 0.3)));
    }
    const end = Math.min(bufLen, start + maxLen);

    const showBefore = displayBuf.slice(start, this.cursorPos);
    const showAt     = displayBuf[this.cursorPos] || ' ';
    const showAfter  = displayBuf.slice(this.cursorPos + 1, end);

    const leftClip  = start > 0;
    const rightClip = end < bufLen;

    const displayText =
      `${prompt}` +
      (leftClip  ? `${DIM}${FG.gray}…${RESET_BG}` : '') +
      `${FG.black}${showBefore}${REVERSE}${showAt}${RESET_BG}${FG.black}${showAfter}${RESET_BG}` +
      (rightClip ? `${DIM}${FG.gray}…${RESET_BG}` : '');

    out.write(cursorTo(row, 1) + BG.white + displayText + eraseLine(0));
  }
}














































































































































