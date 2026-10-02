/**
 * patch-revert.js — 按 unified diff 逆向还原文件内容
 *
 * 背景：.diff 历史文件里只有「上下文 + 删除行 + 新增行」，没存改动前的完整内容。
 * 但生成时（见 src/tools/patch-diff.ts）上下文取自「改动前」文件的前后相邻行，
 * 因此逆向还原的锚点仍然成立：
 *
 *   改动前：  before  removed  after
 *   改动后：  before  added    after
 *
 * 于是拿 after 做锚点定位即可：
 *   1. 优先用「before + added + after」整体定位（最稳，唯一命中概率最高）
 *   2. 退化为「before + added」找起点
 *   3. 再退化为只用 added
 * 命中后把 [start, start + added.length) 换成 removed，before/after 保持不动。
 *
 * 已知局限（权衡后的取舍）：
 *   - 生成器只保留改动段前后各 2 / 3 行上下文。若 added 或 after 在文件里重复出现，
 *     无歧义信息不足时可能定位到别处。此时宁可失败也不乱写：返回 notFound，
 *     由调用方提示用户手动处理。
 */

/** 一条逆向还原记录 */
export class RevertError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 把 unified diff 正文解析成「上下文 / 删除 / 新增 / 上下文」四段。
 * 结构与渲染层 patch-merge.parseHunk 一致，这里用 JS 重写以便主进程直接引用。
 * @param {string} diff unified diff 正文
 * @returns {{ before: string[], removed: string[], added: string[], after: string[] } | null}
 */
export function parseUnifiedDiff(diff) {
  if (!diff) return null;
  const lines = diff.split('\n');
  let i = 0;

  const takeWhile = (pred) => {
    const out = [];
    while (i < lines.length && pred(lines[i])) out.push(lines[i++].slice(1));
    return out;
  };

  const before = takeWhile(l => l.startsWith(' '));
  const removed = takeWhile(l => l.startsWith('-'));
  const added = takeWhile(l => l.startsWith('+'));
  const after = takeWhile(l => l.startsWith(' '));

  // 尾部还有非空内容说明结构不符合预期，交给调用方跳过而不是猜
  if (i < lines.length && lines[i].trim() !== '') return null;
  if (removed.length === 0 && added.length === 0) return null;
  return { before, removed, added, after };
}

/** 在 lines 中从 from 起查找 needle 连续序列，返回首个匹配下标；未命中返回 -1 */
function indexOfSequence(lines, needle, from = 0) {
  if (needle.length === 0) return -1;
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

/**
 * 在当前内容中定位这条 diff 的落点。
 *
 * 返回 `anchor` 记录本次实际用上的锚点级别：调用方据此决定「该匹配有多可信」。
 * 三级锚点信息量依次递减——用了前后文的定位基本不会错；只靠新增行定位时，
 * 文件里若有多处相同内容就可能落错位置，需要调用方再加验证。
 *
 * @returns {{start:number, end:number, anchor:'full'|'beforeAdded'|'addedOnly'|'beforeAfter'|'beforeOnly'} | null}
 *          end 为新增段结束（不含）
 */
export function locateDiff(lines, parsed) {
  const { before, added, after } = parsed;

  // 纯删除（added 为空）：落点是 before 与 after 之间的零宽区间
  if (added.length === 0) {
    const p = indexOfSequence(lines, [...before, ...after]);
    if (p !== -1) return { start: p + before.length, end: p + before.length, anchor: 'beforeAfter' };
    const q = indexOfSequence(lines, before);
    if (q !== -1) return { start: q + before.length, end: q + before.length, anchor: 'beforeOnly' };
    return null;
  }

  // 首选：前文 + 新增 + 后文，三重锚点
  if (after.length > 0) {
    const p = indexOfSequence(lines, [...before, ...added, ...after]);
    if (p !== -1) {
      const start = p + before.length;
      return { start, end: start + added.length, anchor: 'full' };
    }
  }
  // 退化一：前文 + 新增
  const q = indexOfSequence(lines, [...before, ...added]);
  if (q !== -1) {
    const start = q + before.length;
    return { start, end: start + added.length, anchor: 'beforeAdded' };
  }
  // 退化二：只用新增
  const r = indexOfSequence(lines, added);
  if (r !== -1) return { start: r, end: r + added.length, anchor: 'addedOnly' };
  return null;
}

/**
 * 落点可信度校验：按「本次实际用了哪些锚点」逐项复核。
 *
 * 关键点：不能无条件要求前后文都紧邻落点——当定位已经退化到「只用新增行」时，
 * before / after 本来就可能不在落点旁边，硬校验会把正确的还原误判成失败。
 * 因此只校验确实参与匹配的那几段。
 */
function verifySpan(lines, parsed, span) {
  const { before, after } = parsed;

  if (span.anchor === 'full') {
    // 前文、后文都参与过匹配，两者都必须真正落位
    const beforeOk = before.length === 0
      || indexOfSequence(lines, before, span.start - before.length) === span.start - before.length;
    const afterOk = after.length === 0
      || indexOfSequence(lines, after, span.end) === span.end;
    return beforeOk && afterOk;
  }

  if (span.anchor === 'beforeAdded' || span.anchor === 'beforeOnly') {
    // 只用到了前文：验前文是否确实紧邻落点
    return before.length === 0
      || indexOfSequence(lines, before, span.start - before.length) === span.start - before.length;
  }

  if (span.anchor === 'beforeAfter') {
    // 纯删除且用上了后文：验后文是否紧贴落点
    return after.length === 0 || indexOfSequence(lines, after, span.end) === span.end;
  }

  // addedOnly：没有任何上下文参与匹配，属于最弱锚点。
  // 此时若 diff 里确实带了上下文，说明上下文与当前内容不符，
  // 落点可疑（很可能只是「新增行恰好相同」的别处），一律判为不可信。
  if (before.length > 0 || after.length > 0) return false;
  return true;
}

/**
 * 按 unified diff 逆向还原内容。
 *
 * @param {string} content   当前文件全文
 * @param {string} diff      unified diff 正文
 * @returns {string} 还原后的内容
 * @throws {RevertError} code='badDiff' | 'notFound'
 */
export function revertContent(content, diff) {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed) throw new RevertError('badDiff', '改动记录结构无法解析');

  const lines = content.split('\n');
  const span = locateDiff(lines, parsed);
  if (!span) throw new RevertError('notFound', '当前内容与改动记录对不上，无法定位要回退的位置');

  // 按实际用上的锚点复核：对不上说明是「看起来像」的别处，宁可不改
  if (!verifySpan(lines, parsed, span)) {
    throw new RevertError('notFound', '当前内容与改动记录对不上（上下文不匹配）');
  }

  const next = [
    ...lines.slice(0, span.start),
    ...parsed.removed,
    ...lines.slice(span.end),
  ];
  return next.join('\n');
}
