/**
 * patch-locator.ts — 基于上下文行（pretext/endtext）的定位
 *
 * 两级匹配策略：
 *   1. 归一化精确匹配（trim 行尾空白 / \r 后逐行全等）—— 零误匹配风险，覆盖大多数"复述误差"
 *   2. 模糊相似度匹配（Levenshtein 归一化 + 前导空白归一化）—— 容忍缩进、引号、内容微差
 * 锚点窗口内优先搜索，窗口无候选时全局兜底；行号锚点只用于"分数接近时选更近的候选"。
 * 返回最佳候选组合及信度，失败时显式报错而非静默回退行号。
 */

export interface LocateResult {
  matched: boolean;
  /** pretext 末行之后的第一行（1-based），作为操作的起始行 */
  pretextEndLine: number;
  /** endtext 的首行（1-based），作为操作的结束行（不含） */
  endtextStartLine: number;
  message: string;
  /** 最佳候选的组合信度 0-1（1 = 归一化后全等） */
  confidence: number;
  /** 命中方式：exact=归一化全等 / fuzzy=相似度命中 / none=未提供上下文或未命中 */
  method: 'exact' | 'fuzzy' | 'none';
}

interface Candidate {
  /** 0-based 起始行索引；-1 表示未提供该段上下文（视为完美占位） */
  index: number;
  score: number;
  rowScores: number[];
}

const MIN_ROW_SCORE = 0.6;   // 单行相似度下限，低于此视为该行不匹配
const MIN_SEQ_SCORE = 0.8;   // 序列（组合）信度下限
const MAX_CANDIDATES = 4;    // 每段上下文保留的候选数，供联合搜索枚举
const INDENT_TOLERANCE = 4;  // 前导空白差在此范围内视为"仅缩进差异"

/** 归一化：去掉行尾空白与 \r，消除最常见的复述误差 */
function normalizeLine(line: string): string {
  return line.replace(/\r$/, '').replace(/[ \t]+$/, '');
}

/** 字符级编辑距离（带长度预筛 + 距离上限剪枝） */
function levenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // 长度悬殊直接判超限
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  const prev = new Uint32Array(b.length + 1);
  const curr = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1; // 剪枝：整行已超上限
    prev.set(curr);
  }
  return prev[b.length];
}

/** 单行相似度 0-1 */
function lineSimilarity(a: string, b: string): number {
  const na = normalizeLine(a);
  const nb = normalizeLine(b);
  if (na === nb) return 1;

  // 前导空白归一化：去掉前导空白后内容相同、仅缩进差在小范围内 → 高分（0.9）
  // 覆盖"模型整块缩进偏移"这一高频复述误差；0.9 仍低于精确匹配，不会挤掉真正的精确候选
  const indentA = (na.match(/^[ \t]*/) ?? [''])[0].length;
  const indentB = (nb.match(/^[ \t]*/) ?? [''])[0].length;
  const coreA = na.slice(indentA);
  const coreB = nb.slice(indentB);
  if (coreA === coreB && Math.abs(indentA - indentB) <= INDENT_TOLERANCE) {
    return 0.9;
  }

  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  const minLen = Math.min(na.length, nb.length);
  // 长度差异过大（超过 3 倍）直接判不匹配，避免无谓的 DP
  if (maxLen > minLen * 3) return 0;
  // 单行信度下限对应最大允许距离
  const maxDist = Math.floor(maxLen * (1 - MIN_ROW_SCORE)) + 1;
  const dist = levenshtein(na, nb, maxDist);
  if (dist > maxDist) return 0;
  return Math.max(0, 1 - dist / maxLen);
}

/** 在 [startFrom, endAt)（0-based 行索引区间）内收集 needle 的最佳候选，按分数降序 */
function collectCandidates(
  fileLines: string[],
  needle: string[],
  startFrom: number,
  endAt: number,
): Candidate[] {
  const nLen = needle.length;
  const lastStart = endAt - nLen;
  if (lastStart < startFrom) return [];

  const cands: Candidate[] = [];
  for (let i = startFrom; i <= lastStart; i++) {
    const rowScores: number[] = new Array(nLen);
    let ok = true;
    let total = 0;
    for (let j = 0; j < nLen; j++) {
      const s = lineSimilarity(fileLines[i + j] ?? '', needle[j]);
      if (s < MIN_ROW_SCORE) { ok = false; break; }
      rowScores[j] = s;
      total += s;
    }
    if (!ok) continue;
    const score = total / nLen;
    if (score < MIN_SEQ_SCORE) continue;
    // 插入排序维护 top-N
    let inserted = false;
    for (let k = 0; k < cands.length; k++) {
      if (score > cands[k].score) {
        cands.splice(k, 0, { index: i, score, rowScores });
        inserted = true;
        break;
      }
    }
    if (!inserted && cands.length < MAX_CANDIDATES) cands.push({ index: i, score, rowScores });
    if (cands.length > MAX_CANDIDATES) cands.length = MAX_CANDIDATES;
  }
  return cands;
}

/**
 * contextLocate — 基于上下文行（pretext/endtext）的定位
 *
 * 在 [anchor-radius, anchor+radius] 范围内搜索 pretext / endtext；
 * radius <= 0 时为全局搜索。窗口内无候选时自动全局兜底。
 * 联合枚举两段候选组合（endtext 必须位于 pretext 之后），取信度最高者。
 * 锚点仅用于分数接近（±0.02）时优先选择更近的候选。
 *
 * 返回语义：
 *   pretextEndLine   — pretext 末行之后的第一行（1-based），作为操作的起始行
 *   endtextStartLine — endtext 的首行（1-based），作为操作的结束行（不含）
 *   各工具根据自身语义使用这两个值
 */
export function contextLocate(
  fileLines: string[],
  pretext: string[] | undefined,
  endtext: string[] | undefined,
  anchorStart: number,
  anchorEnd: number,
  radius: number = 20,
): LocateResult {
  const totalLines = fileLines.length;
  // radius <= 0 表示全局搜索，不依赖锚点窗口（del_patch 等无可靠锚点的场景）
  const searchStart = radius <= 0 ? 1 : Math.max(1, anchorStart - radius);
  const searchEnd = radius <= 0 ? totalLines : Math.min(totalLines, anchorEnd + radius);

  // 未提供上下文时返回无匹配
  if ((!pretext || pretext.length === 0) && (!endtext || endtext.length === 0)) {
    return { matched: false, pretextEndLine: 0, endtextStartLine: 0, message: '未提供上下文行，使用原始行号', confidence: 0, method: 'none' };
  }

  const anchorCenter = (anchorStart + anchorEnd) / 2;
  const pProvided = !!(pretext && pretext.length > 0);
  const eProvided = !!(endtext && endtext.length > 0);
  let pCands: Candidate[] = pProvided
    ? collectCandidates(fileLines, pretext!, searchStart - 1, searchEnd)
    : [{ index: -1, score: 1, rowScores: [] }];
  let eCands: Candidate[] = eProvided
    ? collectCandidates(fileLines, endtext!, searchStart - 1, searchEnd)
    : [{ index: -1, score: 1, rowScores: [] }];

  // 窗口内无候选时全局兜底，避免锚点偏离导致整次匹配失败
  if (radius > 0) {
    if (pProvided && pCands.length === 0) pCands = collectCandidates(fileLines, pretext!, 0, totalLines);
    if (eProvided && eCands.length === 0) eCands = collectCandidates(fileLines, endtext!, 0, totalLines);
  }

  const pLen = pretext?.length ?? 0;
  const eLen = endtext?.length ?? 0;
  const totalLen = pLen + eLen;

  let best: { pc: Candidate; ec: Candidate; score: number; dist: number } | null = null;

  for (const pc of pCands) {
    // endtext 必须位于 pretext 之后（0-based 起始索引）
    const eFrom = pc.index >= 0 ? pc.index + pLen : searchStart - 1;
    for (const ec of eCands) {
      if (ec.index >= 0 && ec.index < eFrom) continue;
      // 组合信度：按两段各自行数加权平均
      const comboScore = totalLen > 0
        ? (pc.score * pLen + ec.score * eLen) / totalLen
        : 1;
      // 候选中心到锚点的距离（1-based）
      const center = pc.index >= 0
        ? pc.index + 1 + pLen / 2
        : ec.index >= 0 ? ec.index + 1 + eLen / 2 : anchorCenter;
      const dist = Math.abs(center - anchorCenter);
      if (!best
        || comboScore > best.score + 0.02
        || (Math.abs(comboScore - best.score) <= 0.02 && dist < best.dist)) {
        best = { pc, ec, score: comboScore, dist };
      }
    }
  }

  if (!best || best.score < MIN_SEQ_SCORE) {
    return {
      matched: false, pretextEndLine: 0, endtextStartLine: 0,
      message: (pretext ? 'pretext 未匹配' : '') + (pretext && endtext ? '；' : '') + (endtext ? 'endtext 未匹配' : ''),
      confidence: best?.score ?? 0, method: 'fuzzy',
    };
  }

  const { pc, ec } = best;
  const allExact = [...(pLen ? pc.rowScores : []), ...(eLen ? ec.rowScores : [])].every(s => s === 1);
  const method: 'exact' | 'fuzzy' = allExact ? 'exact' : 'fuzzy';
  const pretextEndLine = pc.index >= 0 ? pc.index + pLen + 1 : 0;
  const endtextStartLine = ec.index >= 0 ? ec.index + 1 : 0;

  const parts: string[] = [];
  if (pretext && pc.index >= 0) parts.push('pretext 匹配于行 ' + (pc.index + 1) + '-' + (pc.index + pLen));
  if (endtext && ec.index >= 0) parts.push('endtext 匹配于行 ' + (ec.index + 1) + '-' + (ec.index + eLen));
  parts.push('信度 ' + Math.round(best.score * 100) + '%');
  if (method === 'fuzzy') parts.push('模糊匹配');

  return {
    matched: true, pretextEndLine, endtextStartLine,
    message: parts.join('；'),
    confidence: best.score, method,
  };
}

