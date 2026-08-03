import type { UIState, UIMessage } from './types';
import { formatTime, truncate, visibleWidth } from './utils';

/**
 * 将一条消息格式化为「渲染块」：每块包含若干行，每行是 { text, color?, dim?, bold? }。
 * 供 Ink 组件逐行渲染。颜色使用 Ink 支持的命名色。
 */
export interface StyledLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

export interface MessageBlock {
  /** 该消息渲染出的所有行 */
  lines: StyledLine[];
  /** 消息所属角色（用于消息间分隔等） */
  role: UIMessage['role'];
}

const USER_NAME = '祝景玥';
const AGENT_NAME = '小鲸鱼Deepseek';

/** 简单 markdown 行渲染：标题/列表/引用/代码块/行内粗体反引号 */
function markdownLine(raw: string, inCode: boolean): StyledLine {
  const t = raw.replace(/\r/g, '');
  if (inCode) return { text: `│ ${t}`, color: 'gray' };

  // 标题
  const h = t.match(/^(#{1,3})\s+(.+)$/);
  if (h) return { text: h[2], bold: true, color: ['magenta', 'blue', 'cyan'][h[1].length - 1] };
  // 引用
  const q = t.match(/^>\s*(.*)$/);
  if (q) return { text: `▍ ${q[1]}`, color: 'gray' };
  // 无序列表
  const ul = t.match(/^[-*]\s+(.*)$/);
  if (ul) return { text: `• ${ul[1]}`, color: 'cyan' };
  // 有序列表
  const ol = t.match(/^(\d+)\.\s+(.*)$/);
  if (ol) return { text: `${ol[1]}. ${ol[2]}`, color: 'cyan' };
  // 分割线
  if (/^-{3,}$/.test(t)) return { text: '─'.repeat(40), color: 'gray', dim: true };
  // 行内粗体 + 反引号
  const inline = t
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  return { text: inline };
}

/** 将一条消息格式化为多行（含简单 markdown / 代码块识别） */
export function formatMessage(msg: UIMessage, width: number): MessageBlock {
  const lines: StyledLine[] = [];
  const w = Math.max(20, width);

  switch (msg.role) {
    case 'divider':
      lines.push({ text: '─'.repeat(Math.max(2, w - 2)), color: 'gray', dim: true });
      break;
    case 'blank':
      lines.push({ text: '' });
      break;
    case 'banner':
      for (const l of msg.content.split('\n')) lines.push({ text: l, color: 'cyan', dim: true });
      break;
    case 'system':
      for (const l of msg.content.split('\n')) lines.push({ text: l, color: 'yellow' });
      break;
    case 'user': {
      const time = formatTime(msg.createdAt);
      lines.push({ text: `${USER_NAME} ${time} |`, color: 'cyan', bold: true });
      for (const l of msg.content.split('\n')) lines.push({ text: l, color: 'white' });
      lines.push({ text: `╰${'═'.repeat(Math.min(w - 2, visibleWidth(USER_NAME + time) + 2))}╯`, color: 'cyan' });
      break;
    }
    case 'subagent': {
      const sname = msg.subagentName ?? '(子模型)';
      lines.push({ text: `${sname} ${formatTime(msg.createdAt)} |`, color: 'green', bold: true });
      for (const l of msg.content.split('\n')) lines.push(markdownLine(l, false));
      break;
    }
    case 'instructor': {
      const sname = msg.subagentName ?? '教练';
      lines.push({ text: `🐋 ${sname} ${formatTime(msg.createdAt)} |`, color: 'cyan', bold: true });
      for (const l of msg.content.split('\n')) lines.push(markdownLine(l, false));
      break;
    }
    case 'agent': {
      lines.push({ text: `${AGENT_NAME} ${formatTime(msg.createdAt)}`, color: 'white', bold: true });
      let inCode = false;
      let codeBuf: string[] = [];
      const flushCode = () => {
        if (codeBuf.length > 0) {
          lines.push({ text: '┌─ code ─'.padEnd(w - 2, '─'), color: 'gray', dim: true });
          for (const cl of codeBuf) lines.push({ text: `│ ${cl}`, color: 'gray' });
          lines.push({ text: '└─'.padEnd(w - 2, '─'), color: 'gray', dim: true });
          codeBuf = [];
        }
      };
      for (const raw of msg.content.split('\n')) {
        if (/^```/.test(raw)) {
          if (inCode) { flushCode(); inCode = false; }
          else inCode = true;
          continue;
        }
        if (inCode) { codeBuf.push(raw); continue; }
        if (raw === '') { flushCode(); lines.push({ text: '' }); continue; }
        lines.push(markdownLine(raw, false));
      }
      if (inCode) flushCode();
      break;
    }
    case 'tool': {
      if (msg.doNotRender) break;
      const toolName = msg.toolMeta?.toolName;
      const prefix = msg.collapsed
        ? (toolName ? `▸ ${toolName}` : '▸ 工具')
        : (toolName ? `⚙ ${toolName}` : '⚙ 工具');
      const first = msg.content.split('\n')[0];
      const head = msg.collapsed ? first : truncate(first, w - 10);
      lines.push({ text: msg.collapsed ? `${prefix} — ${head}` : prefix, color: msg.collapsed ? 'gray' : 'magenta', dim: msg.collapsed });
      if (!msg.collapsed) {
        for (const l of msg.content.split('\n').slice(1)) {
          if (l.trim()) lines.push({ text: l, color: 'gray', dim: true });
        }
      }
      break;
    }
    default:
      for (const l of msg.content.split('\n')) lines.push({ text: l });
  }

  return { lines, role: msg.role };
}

/**
 * 把全部消息格式化为扁平行数组（供滚动窗口切片）。
 * 返回 [line, msgIndex] 对，以便恢复消息边界。
 */
export function flattenBlocks(blocks: MessageBlock[]): Array<{ line: StyledLine; msgIndex: number }> {
  const out: Array<{ line: StyledLine; msgIndex: number }> = [];
  blocks.forEach((b, i) => {
    for (const line of b.lines) out.push({ line, msgIndex: i });
  });
  return out;
}

/** 从 UIState 生成渲染块列表 */
export function buildBlocks(state: UIState, width: number): MessageBlock[] {
  return state.messages.map((m: UIMessage) => formatMessage(m, width));
}

