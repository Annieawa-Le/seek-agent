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
 *   2. 开头无标题的引言（如 MAIN.md 首段）独立成块，标题取内容摘要；
 *   3. 整个 system 没有任何一级标题时，回退为按空行切分 + 短段合并；
 *   4. 重组 = 各块 content 按序 join('\n\n')，与原文逐字节等价（除多余空行规范化）。
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

/** 从段文本提取语义标题：首行 `# ` 标题优先；否则取首个非空行/前若干字符做摘要 */
export function extractBlockTitle(content: string): string {
  const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? '';
  const m = /^#+\s+(.+)$/.exec(firstLine.trim());
  if (m) return m[1].trim();
  const plain = firstLine.replace(/[#*`>]/g, '').trim();
  const title = plain || content.replace(/\s+/g, ' ').trim();
  return title.length > 24 ? `${title.slice(0, 24)}…` : title;
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
  const hasHeading = lines.some(l => /^#\s+/.test(l));
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
  for (const line of lines) {
    const m = /^#\s+(.+)$/.exec(line);
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

