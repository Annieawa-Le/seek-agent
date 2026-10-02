/* ═══════════════════════════════════════════════════════════
   从 DOM 选区反查代码上下文

   审查模式的内联差异视图不是 textarea，而是一堆 <span.inline-diff-row>
   渲染出来的块级文本。浏览器原生 selection 能用，但拿到的是渲染后的
   结构，需要再翻回「文件里的第几行、内容是什么」。

   两条规则（与 InlineDiffView 的渲染约定对齐）：
   1. 只认带 data-line 的行（上下文行 + 新增行）。删除的「幽灵行」没有
      data-line，既不参与行号范围，也不进入代码块——它是改动前的历史，
      不是当前代码。
   2. 代码正文不取 DOM 文本，而是用行号回到源文件切片。DOM 里混着高亮
      span 与 +/- 标记，取文本会被污染；行号切片是精确的。
   ═══════════════════════════════════════════════════════════ */

/** 反查所需的行元素选择器（InlineDiffView 渲染的行） */
export const DIFF_ROW_SELECTOR = '.inline-diff-row[data-line]';

export interface DomSelectionContext {
  /** 文件绝对路径 */
  filePath: string;
  /** 选区覆盖的起始行号（1 基） */
  startLine: number;
  /** 选区覆盖的结束行号（1 基） */
  endLine: number;
  /** 选中的代码原文（按行拼接，来自源文件切片） */
  code: string;
}

/** 从元素反查所属的行元素（自身或最近的祖先） */
function rowOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el?.closest<HTMLElement>(DIFF_ROW_SELECTOR) ?? null;
}

/** 读某行元素的行号；无 data-line 时返回 null */
function lineNoOf(el: HTMLElement | null): number | null {
  if (!el) return null;
  const raw = el.getAttribute('data-line');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 由选区的两个端点行号（各自可能为 null）收敛出规范区间，并按行号切片取正文。
 *
 * 规则：
 * - 两端都为 null（例如整段选区都落在幽灵删除行里）→ null
 * - 只有一端有效 → 用有效的那端兜底，避免行号区间悬空
 * - 反向选区（从下往上拖）→ 统一成 [小的, 大的]
 * - 切出的内容全是空白 → null（没有追问价值）
 *
 * 与 DOM 无关，便于单测。
 */
export function rangeToContext(
  lines: string[],
  filePath: string,
  start: number | null,
  end: number | null,
): DomSelectionContext | null {
  let startLine = start;
  let endLine = end;
  if (startLine === null && endLine === null) return null;
  if (startLine === null) startLine = endLine;
  if (endLine === null) endLine = startLine;
  if (startLine === null || endLine === null) return null;

  if (startLine > endLine) [startLine, endLine] = [endLine, startLine];

  // 行号来自 DOM 属性，越界时按读取不到处理（宁可不显示，也不要给出错的行号）
  if (startLine < 1 || endLine > lines.length) return null;

  const code = lines.slice(startLine - 1, endLine).join('\n');
  if (!code.trim()) return null;

  return { filePath, startLine, endLine, code };
}

/**
 * 解析当前窗口选区落在差异视图上的上下文。
 *
 * 返回 null 的情形（调用方据此收起工具栏）：
 * - 没有选区 / 选区折叠
 * - 起止点都不在任何差异行上（选到了编辑器之外的东西）
 * - 选区只覆盖幽灵删除行（没有可归属的真实行号）
 * - 选区内容全是空白
 *
 * @param lines 当前文件内容（按行拆开），用于按行号切片取正文
 * @param filePath 文件绝对路径
 */
export function resolveDomSelection(
  lines: string[],
  filePath: string,
): DomSelectionContext | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  // 取不到行元素（选区在差异视图之外）时传 null，交给 rangeToContext 判定
  const startLine = lineNoOf(rowOf(range.startContainer));
  const endLine = lineNoOf(rowOf(range.endContainer));
  return rangeToContext(lines, filePath, startLine, endLine);
}
