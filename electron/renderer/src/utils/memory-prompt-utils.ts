/**
 * 记忆面板工具：system prompt 的语义分块 / 重组。
 *
 * 系统 Prompt 由多个文件拼接（MAIN.md、platform 说明、WORKFLOW.md、技能列表、
 * SYSTEM_INJECTION、SEEK.md、MCP 指令、模式 addon、会话指令等），段间以空行分隔，
 * 每个文件内部又有大量 \n\n 分隔的 markdown 段落——若按空行切分会被切成几十块。
 *
 * 分块策略（按一级标题聚合，避免碎片化）：
 *   1. 逐行扫描，`# 标题` 行开启新块：该标题到下一个一级标题前的内容（含 ## 子标题
 *      与无标题散段，如 platform 说明、工作目录行、MCP 指令等）都归入该块；
 *   2. 代码块围栏（``` 或 ~~~）内的 `#` 行（shell 注释等）不当作标题；
 *   3. 开头无标题的引言（如 MAIN.md 首段）独立成块，标题取内容摘要；
 *   4. 整个 system 没有任何一级标题时，回退为按空行切分 + 短段合并；
 *   5. 重组 = 各块 content 按序 join('\n\n')，与原文逐字节等价（除多余空行规范化）。
 *
 * 子标题树：buildSubTree 把一级块内容里的 ##+ 标题解析成可折叠树（纯展示派生，
 * 不改块 content，重组可逆性不受影响），供记忆面板渲染逐级可展开的标签。
 */

export interface PromptBlock {
  /** 稳定 id（内容 hash + 序号，用于 React key 与拖动） */
  id: string;
  /** 语义标题（# 标题行或内容摘要） */
  title: string;
  /** 块全文（含标题行，重组时按序拼接） */
  content: string;
}

/** 简单内容 hash：8 位十六进制（非加密用途，仅用于稳定标识） */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

/** 从段文本提取语义标题：首个围栏外非空行的 `# ` 标题优先；否则取该行/前若干字符做摘要 */
export function extractBlockTitle(content: string): string {
  // 跳过代码块围栏行及其内部行（```ts、围栏内 # 注释等），避免提取成伪标题
  let firstLine = '';
  let inFence = false;
  for (const l of content.split('\n')) {
    if (isFenceLine(l)) { inFence = !inFence; continue; }
    if (inFence || l.trim().length === 0) continue;
    firstLine = l;
    break;
  }
  const m = /^#+\s+(.+)$/.exec(firstLine.trim());
  if (m) return m[1].trim();
  const plain = firstLine.replace(/[#*`>]/g, '').trim();
  const title = plain || content.replace(/\s+/g, ' ').trim();
  return title.length > 24 ? `${title.slice(0, 24)}…` : title;
}

/** 代码块围栏行（``` 或 ~~~ 开头的行，允许前导空格） */
function isFenceLine(line: string): boolean {
  return /^\s*(```+|~~~+)/.test(line);
}

/**
 * 一级块内容里的子标题树节点（纯展示派生，不改块 content）。
 * lines 为该节点标题行以下、下一个同级/上级标题之前的内容行。
 * linesStart/linesEnd 为该段正文在块 content 行数组中的 1-based 行号区间（含），
 * 供 applyNodeEdit 精确替换；无正文时 linesEnd = linesStart - 1（空区间）。
 */
export interface PromptSubNode {
  /** 稳定 id（内容 hash + 序号，用于 React key 与折叠状态） */
  id: string;
  /** 标题级别（2..6，对应 ##+ 的井号数） */
  level: number;
  /** 标题文本 */
  title: string;
  /** 本节点直属内容行（不含子节点内容） */
  lines: string[];
  /** 本节点正文起始行号（1-based，标题行 + 1） */
  linesStart: number;
  /** 本节点正文结束行号（1-based 含；无正文时 = linesStart - 1） */
  linesEnd: number;
  /** 下级标题节点 */
  children: PromptSubNode[];
}

/** buildSubTree 的返回：块内第一个子标题前的散段 + 子标题树 */
export interface PromptSubTree {
  /** 第一个子标题之前的内容（引言/散段），无则空串 */
  preamble: string;
  /** preamble 起始行号（1-based，无内容时 = 1） */
  preambleStart: number;
  /** preamble 结束行号（1-based 含；无内容时 = preambleStart - 1） */
  preambleEnd: number;
  /** 子标题树根列表 */
  nodes: PromptSubNode[];
}

/**
 * 解析一级块内容里的 ##+ 标题树（代码块围栏内的 # 行忽略）。
 * 栈式构建：遇到 ## 开新根，### 挂到当前 ## 下，更深的依此类推；
 * 回到同级/更高级别时出栈。非标题行归入当前节点（无节点时归入 preamble）。
 * 每个节点/preamble 记录正文行号区间，供段落级编辑精确替换。
 */
export function buildSubTree(content: string): PromptSubTree {
  const nodes: PromptSubNode[] = [];
  const stack: PromptSubNode[] = [];
  let preambleLines: string[] = [];
  let inFence = false;
  let seq = 0;
  let lineNo = 0; // 1-based 行号
  const pushLine = (line: string, no: number) => {
    if (stack.length > 0) {
      const top = stack[stack.length - 1];
      top.lines.push(line);
      top.linesEnd = no;
    } else {
      preambleLines.push(line);
    }
  };
  for (const line of content.split('\n')) {
    lineNo++;
    if (isFenceLine(line)) { inFence = !inFence; pushLine(line, lineNo); continue; }
    const m = !inFence ? /^(#{2,6})\s+(.+)$/.exec(line) : null;
    if (m) {
      const level = m[1].length;
      const node: PromptSubNode = {
        id: `s${seq++}_${simpleHash(m[2].trim())}`,
        level,
        title: m[2].trim(),
        lines: [],
        linesStart: lineNo + 1,
        linesEnd: lineNo,
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length === 0) nodes.push(node);
      else stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      pushLine(line, lineNo);
    }
  }
  return {
    preamble: preambleLines.join('\n'),
    preambleStart: 1,
    preambleEnd: preambleLines.length,
    nodes,
  };
}

/**
 * 段落级编辑：把块 content 中 [start, end]（1-based 含）行区间替换为 newText。
 * 传入节点或 preamble 的行号区间；未触及的行逐字节保留。
 */
export function applyNodeEdit(content: string, start: number, end: number, newText: string): string {
  const lines = content.split('\n');
  const s = Math.max(0, start - 1);
  const e = Math.min(lines.length, end);
  // 空文本 = 删除区间，不插入任何行；空区间 + 空文本 = 无变化
  const newLines = newText ? newText.replace(/\r\n/g, '\n').split('\n') : [];
  if (s >= e && newLines.length === 0) return content;
  return [...lines.slice(0, s), ...newLines, ...lines.slice(e)].join('\n');
}

/** 判断一段是否适合并入前一块：过短、无结构标记、且前一块足够长（避免连续短段无限制并成一块） */
function isFragmentedSegment(seg: string, prevContent: string): boolean {
  if (seg.includes('\n')) return false; // 多行段即使短也有结构
  const trimmed = seg.trim();
  if (!trimmed) return false;
  // markdown 结构标记开头（标题/引用/列表/表格/代码等）：即使短也是独立语义条目
  if (/^[#>|*`\-\d]/.test(trimmed)) return false;
  return trimmed.length < 40 && prevContent.length > 200;
}

/** 语义分块：system prompt 字符串 → 条目列表（一级标题聚合，无标题时回退段落切分） */
export function splitPromptBlocks(system: string): PromptBlock[] {
  if (!system || !system.trim()) return [];

  const lines = system.split('\n');
  // 代码块围栏感知：围栏内的 # 行（shell 注释等）不当作标题
  let probeInFence = false;
  const hasHeading = lines.some(l => {
    if (isFenceLine(l)) { probeInFence = !probeInFence; return false; }
    return !probeInFence && /^#\s+/.test(l);
  });
  if (!hasHeading) return splitByParagraph(system);

  const blocks: PromptBlock[] = [];
  let curTitle = '';
  let curLines: string[] = [];
  const pushCur = () => {
    const content = curLines.join('\n').trim();
    if (!content) return;
    blocks.push({
      id: `b${blocks.length}_${simpleHash(content)}`,
      title: curTitle || extractBlockTitle(content),
      content,
    });
  };
  let inFence = false;
  for (const line of lines) {
    if (isFenceLine(line)) { inFence = !inFence; curLines.push(line); continue; }
    const m = !inFence ? /^#\s+(.+)$/.exec(line) : null;
    if (m) {
      pushCur();
      curTitle = m[1].trim();
      curLines = [line];
    } else {
      curLines.push(line);
    }
  }
  pushCur();
  return blocks;
}

/** 回退路径：按连续空行切分 + 短段合并（无任何一级标题的纯文本 system） */
function splitByParagraph(system: string): PromptBlock[] {
  const segments = system
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);

  const blocks: PromptBlock[] = [];
  for (const seg of segments) {
    if (blocks.length > 0 && isFragmentedSegment(seg, blocks[blocks.length - 1].content)) {
      // 短段合并到前一块（保留 \n\n 分隔，重组可还原）
      const prev = blocks[blocks.length - 1];
      prev.content = `${prev.content}\n\n${seg}`;
      prev.title = extractBlockTitle(prev.content);
    } else {
      blocks.push({
        id: `b${blocks.length}_${simpleHash(seg)}`,
        title: extractBlockTitle(seg),
        content: seg,
      });
    }
  }
  return blocks;
}

/** 重组：条目列表 → system prompt 字符串（按序 join 空行分隔） */
export function joinPromptBlocks(blocks: PromptBlock[]): string {
  return blocks
    .map(b => b.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 消息文本提取：content 可能是字符串或 parts 数组（TextPart/ToolCallPart），统一为展示摘要 */
export function messageContentText(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const p of c) {
      if (p && typeof p === 'object') {
        const rec = p as Record<string, unknown>;
        if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text);
        else if (rec.type === 'tool-call' && typeof rec.toolName === 'string') {
          parts.push(`[工具调用 ${rec.toolName}]`);
        }
      }
    }
    return parts.join('\n');
  }
  if (c === null || c === undefined) return '';
  return JSON.stringify(c);
}











