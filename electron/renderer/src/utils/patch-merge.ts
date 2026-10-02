/* ═══════════════════════════════════════════════════════════
   patch 合并 —— 把一个文件的多次 patch 归并成「一份最终 patch」

   背景：AI 改一个文件时往往落下好几条 patch 记录，每条只是局部 hunk
   （前后各几行上下文 + 删除行 + 新增行），逐条看无法回答「这个文件现在
   相比改动前到底变了什么」。

   做法（不引入任何 diff 库，也不需要改动前的完整内容）：
     1. 每条 hunk 用「前文上下文 + 新增行」在当前文件内容里定位 —— 新增行
        必然还留在文件里，是最强的锚点；纯删除的 hunk 退化为「前文 + 后文
        相邻」匹配（删完之后这两段就挨在一起了）。
     2. 位置重叠或相接的区间合并成一段。
     3. 合并段的 `added` 直接从当前内容切片 —— 后续 patch 又改过的部分自动
        呈现最终形态，天然精确；`removed` 取该段内时间最早那条 hunk 的删除
        行 —— 那才最接近「改动前的原文」。

   因此定位失败的 hunk（比如所在区域被后来的 patch 整个覆盖）会被跳过：
   它的净效果已经由覆盖它的那条 hunk 表达了，这正是「最终 patch」想要的语义。

   本模块零依赖，可在渲染层与测试脚本中直接使用。
   ═══════════════════════════════════════════════════════════ */

/** 合并所需的最小记录形状（与 types.PatchRecord 结构兼容） */
export interface PatchLike {
  id: string;
  /** 修改时间（毫秒），用于判定同一区域多次改动的新旧 */
  timestamp: number;
  /** unified diff 正文：`-` 删除行 / `+` 新增行 / 空格 上下文行 */
  diff: string;
}

/** 一条 hunk 拆解后的四段结构 */
export interface ParsedHunk {
  /** 变化段之前的上下文行 */
  before: string[];
  /** 被删除的行 */
  removed: string[];
  /** 新增的行 */
  added: string[];
  /** 变化段之后的上下文行 */
  after: string[];
}

/** 合并后的最终 patch 中的一段改动 */
export interface MergedHunk {
  /** 在「改动后」（即当前文件内容）中的行区间 [start, end)，0-based；start === end 表示纯删除 */
  start: number;
  end: number;
  /** 相对「改动前」被删除的行 */
  removed: string[];
  /** 新增的行（即 currentLines.slice(start, end)） */
  added: string[];
  /** 参与这段合并的 patch id（按 id 排序，便于稳定比对） */
  patchIds: string[];
  /** 这段改动中最新一次的时间戳 */
  timestamp: number;
}

export interface MergeResult {
  hunks: MergedHunk[];
  /** 成功定位（计入最终 patch）的 patch 数 */
  located: number;
  /** 传入的 patch 总数 */
  total: number;
}

/**
 * 拆解 unified hunk。仅认「若干上下文 → 若干删除 → 若干新增 → 若干上下文」的
 * 顺序结构（与 src/tools/patch-diff.ts 的输出一致）；含 @@ 头等异形结构时
 * 返回 null，交由调用方跳过而不是猜。
 */
export function parseHunk(diff: string): ParsedHunk | null {
  if (!diff) return null;
  const lines = diff.split('\n');
  let i = 0;

  const takeWhile = (pred: (line: string) => boolean): string[] => {
    const out: string[] = [];
    while (i < lines.length && pred(lines[i])) out.push(lines[i++].slice(1));
    return out;
  };

  const before = takeWhile(l => l.startsWith(' '));
  const removed = takeWhile(l => l.startsWith('-'));
  const added = takeWhile(l => l.startsWith('+'));
  const after = takeWhile(l => l.startsWith(' '));

  // 尾部还有内容说明结构不符合预期
  if (i < lines.length && lines[i].trim() !== '') return null;
  if (removed.length === 0 && added.length === 0) return null;
  return { before, removed, added, after };
}

/** 在 lines 中从 from 起查找 needle 连续序列，返回首次匹配的起始下标；未命中返回 -1 */
function indexOfSequence(lines: string[], needle: string[], from = 0): number {
  if (needle.length === 0) return from;
  const last = lines.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j] !== needle[j]) { hit = false; break; }
    }
    if (hit) return i;
  }
  return -1;
}

/** 该次改动在「改动后」内容中占据的区间 */
interface HunkSpan {
  start: number;
  end: number;
}

/**
 * 在当前文件内容里定位一条 hunk 的落点。
 * 新增行必然存在于当前内容中，故「前文上下文 + 新增行」是最可靠的锚点；
 * 上下文被后续改动波及导致整体匹配失败时，退化为只用新增行定位。
 */
function locateHunk(lines: string[], hunk: ParsedHunk): HunkSpan | null {
  if (hunk.added.length > 0) {
    const p = indexOfSequence(lines, [...hunk.before, ...hunk.added]);
    if (p !== -1) {
      const start = p + hunk.before.length;
      return { start, end: start + hunk.added.length };
    }
    const q = indexOfSequence(lines, hunk.added);
    if (q !== -1) return { start: q, end: q + hunk.added.length };
    return null;
  }

  // 纯删除：改前相邻的「前文 + 后文」在改后依然相邻，落点是一个零宽区间
  const p = indexOfSequence(lines, [...hunk.before, ...hunk.after]);
  if (p !== -1) {
    const at = p + hunk.before.length;
    return { start: at, end: at };
  }
  const q = indexOfSequence(lines, hunk.before);
  if (q !== -1) {
    const at = q + hunk.before.length;
    return { start: at, end: at };
  }
  return null;
}

/** 合并过程中的中间态：额外记住删除行来自哪次改动，重叠时才能取更早的那份 */
interface Candidate extends HunkSpan {
  id: string;
  timestamp: number;
  removed: string[];
  removedTs: number;
}

/** 归并阶段的区间累积器 */
interface Group {
  start: number;
  end: number;
  removed: string[];
  removedTs: number;
  patchIds: string[];
  timestamp: number;
}

/**
 * 把一个文件的多次 patch 合并成一份最终 patch。
 *
 * @param records      该文件的 patch 记录（顺序不限，内部按 timestamp 正序处理）
 * @param currentLines 当前文件内容按行拆开的结果（编辑器里加载到的内容）
 */
export function mergeFilePatches(records: PatchLike[], currentLines: string[]): MergeResult {
  const ordered = [...records].sort((a, b) => a.timestamp - b.timestamp);

  const candidates: Candidate[] = [];
  for (const record of ordered) {
    const hunk = parseHunk(record.diff);
    if (!hunk) continue;
    const span = locateHunk(currentLines, hunk);
    if (!span) continue;
    candidates.push({ ...span, id: record.id, timestamp: record.timestamp, removed: hunk.removed, removedTs: record.timestamp });
  }

  // 按落点排序后合并重叠 / 相接的区间
  candidates.sort((a, b) => a.start - b.start || a.end - b.end);

  const groups: Group[] = [];
  for (const cur of candidates) {
    const last = groups[groups.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.start < last.end) {
        // 真重叠：区间被后来的改动覆盖，删除行以时间更早的那次为准（更接近改动前原文）
        if (cur.removedTs < last.removedTs) {
          last.removed = cur.removed;
          last.removedTs = cur.removedTs;
        }
      } else if (cur.removedTs < last.removedTs) {
        // 相接但当前这次更早：删除行按时间先后拼接
        last.removed = cur.removed.concat(last.removed);
        last.removedTs = cur.removedTs;
      } else {
        last.removed = last.removed.concat(cur.removed);
      }
      last.end = Math.max(last.end, cur.end);
      if (!last.patchIds.includes(cur.id)) last.patchIds.push(cur.id);
      last.timestamp = Math.max(last.timestamp, cur.timestamp);
      continue;
    }
    groups.push({
      start: cur.start,
      end: cur.end,
      removed: cur.removed,
      removedTs: cur.removedTs,
      patchIds: [cur.id],
      timestamp: cur.timestamp,
    });
  }

  const hunks: MergedHunk[] = groups.map(g => ({
    start: g.start,
    end: g.end,
    removed: g.removed,
    // 新增行统一从当前内容切片：后续 patch 又改过的部分自动呈现最终形态
    added: currentLines.slice(g.start, g.end),
    patchIds: [...g.patchIds].sort(),
    timestamp: g.timestamp,
  }));

  return { hunks, located: candidates.length, total: records.length };
}

/** 一段改动的统计（+新增 / -删除） */
export function countHunkChanges(hunks: MergedHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.added.length;
    removed += h.removed.length;
  }
  return { added, removed };
}

/**
 * 把合并结果还原成 unified diff 文本（每段前后各带 context 行上下文）。
 * 用于复制 / 落盘等需要标准 patch 形态的场景。
 */
export function toUnifiedPatch(lines: string[], hunks: MergedHunk[], context = 3): string {
  if (hunks.length === 0) return '';
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    for (let i = Math.max(cursor, hunk.start - context); i < hunk.start; i++) out.push(` ${lines[i]}`);
    for (const line of hunk.removed) out.push(`-${line}`);
    for (let i = hunk.start; i < hunk.end; i++) out.push(`+${lines[i]}`);
    cursor = hunk.end;
  }
  const tailEnd = Math.min(lines.length, cursor + context);
  for (let i = cursor; i < tailEnd; i++) out.push(` ${lines[i]}`);
  return out.join('\n');
}

