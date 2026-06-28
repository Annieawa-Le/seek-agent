/**
 * patch-locator.ts — 智能行号定位引擎
 *
 * 核心能力：
 * 当 modify_patch / del_patch 接收到的行号可能过期或偏移时，
 * 从「要替换成什么」反向提取特征，在用户锚点附近定位真正需要修改的行。
 *
 * 设计理念：
 * - 不需要用户额外输入 searchLines 或 context
 * - replaceLines（新内容）自动包含特征信号
 * - 只静默微调，不越界修正
 */

import { readFileLines } from './file-manipulation.js';

/** 定位结果 */
export interface LocateResult {
  /** 是否找到了匹配 */
  matched: boolean;
  /** 修正后的 startLine（matched = true 时有意义） */
  startLine: number;
  /** 修正后的 endLine */
  endLine: number;
  /** 置信度 0-150 */
  confidence: number;
  /** 匹配说明 */
  message: string;
}

/** 定位选项 */
export interface LocateOptions {
  /** 用户提供的锚点起始行（1-based） */
  anchorStart: number;
  /** 用户提供的锚点结束行 */
  anchorEnd: number;
  /** 文件完整行数组 */
  fileLines: string[];
  /** 新内容（replaceLines / 插入的 Lines），用于提取特征 */
  newLines: string[];
  /** 搜索半径（在 [anchor-N, anchor+N] 范围内搜索），默认 10 */
  radius?: number;
  /** 操作类型 */
  operation: 'modify' | 'del' | 'add';
}

/**
 * 从新内容行中提取结构特征
 */
function extractFeatures(lines: string[]): {
  /** 基准缩进深度（空格数） */
  baseIndent: number;
  /** 末行缩进深度 */
  lastIndent: number;
  /** 首行的结构化 token */
  firstLineTokens: string[];
  /** 末行的结构化 token */
  lastLineTokens: string[];
  /** 行数 */
  lineCount: number;
  /** 非空行数量 */
  nonEmptyCount: number;
} {
  const nonEmpty = lines.filter(l => l.trim().length > 0);

  const firstNonEmpty = nonEmpty[0] || '';
  const indentMatch = firstNonEmpty.match(/^(\s*)/);
  const baseIndent = indentMatch ? indentMatch[1].length : 0;

  const lastNonEmpty = nonEmpty[nonEmpty.length - 1] || '';
  const lastIndentMatch = lastNonEmpty.match(/^(\s*)/);
  const lastIndent = lastIndentMatch ? lastIndentMatch[1].length : baseIndent;

  const extractTokens = (line: string): string[] => {
    const tokens: string[] = [];
    const keywordMatch = line.trim().match(/^(\w+)\b/);
    if (keywordMatch) tokens.push(keywordMatch[1]);
    const trimmed = line.trim();
    if (trimmed.endsWith('{')) tokens.push('{');
    if (trimmed.endsWith('}')) tokens.push('}');
    if (trimmed.endsWith(';')) tokens.push(';');
    if (trimmed.endsWith(')')) tokens.push(')');
    if (trimmed.endsWith('(')) tokens.push('(');
    if (trimmed.includes('=>')) tokens.push('arrow');
    if (trimmed.includes('=') && !trimmed.includes('==') && !trimmed.includes('===')) tokens.push('assign');
    if (trimmed.includes(':')) tokens.push('colon');
    if (trimmed.includes('`')) tokens.push('template');
    return tokens;
  };

  return {
    baseIndent,
    lastIndent,
    firstLineTokens: lines.length > 0 ? extractTokens(lines[0]) : [],
    lastLineTokens: lines.length > 0 ? extractTokens(lines[lines.length - 1]) : [],
    lineCount: lines.length,
    nonEmptyCount: nonEmpty.length,
  };
}

/**
 * 计算两个特征之间的相似度得分（0-150）
 * @param indentTarget 缩进匹配目标：'first' 用首行缩进，'last' 用末行缩进
 */
function scoreCandidate(
  oldLines: string[],
  newFeatures: ReturnType<typeof extractFeatures>,
  anchorDistance: number,
  indentTarget: 'first' | 'last' = 'first',
): number {
  if (oldLines.length === 0) return 0;

  let score = 0;

  // 1. 同源行数检查（+40）
  if (oldLines.length === newFeatures.lineCount) {
    score += 40;
  } else if (Math.abs(oldLines.length - newFeatures.lineCount) <= 2) {
    score += 20;
  }
  // 2. 缩进匹配（+60 / +10 / +0）
  const targetIndent = indentTarget === 'first' ? newFeatures.baseIndent : newFeatures.lastIndent;
  const oldFirstLine = oldLines.find(l => l.trim().length > 0);
  if (oldFirstLine) {
    const oldIndent = oldFirstLine.match(/^(\s*)/)?.[1].length ?? 0;
    const indentDiff = Math.abs(oldIndent - targetIndent);
    if (indentDiff === 0) {
      score += 60;
    } else if (indentDiff <= 2) {
      score += 10;
    }
  }

  // 3. 边界关键词匹配（+20 + 20）
  const extractOldTokens = (line: string): string[] => {
    const tokens: string[] = [];
    const keywordMatch = line.trim().match(/^(\w+)\b/);
    if (keywordMatch) tokens.push(keywordMatch[1]);
    const trimmed = line.trim();
    if (trimmed.endsWith('{')) tokens.push('{');
    if (trimmed.endsWith('}')) tokens.push('}');
    if (trimmed.endsWith(';')) tokens.push(';');
    if (trimmed.endsWith(')')) tokens.push(')');
    if (trimmed.includes('=>')) tokens.push('arrow');
    return tokens;
  };

  const oldFirstTokens = extractOldTokens(oldLines[0]);
  const firstCommon = oldFirstTokens.filter(t => newFeatures.firstLineTokens.includes(t));
  if (firstCommon.length > 0) {
    score += Math.min(20, firstCommon.length * 10);
  }

  const oldLastTokens = extractOldTokens(oldLines[oldLines.length - 1]);
  const lastCommon = oldLastTokens.filter(t => newFeatures.lastLineTokens.includes(t));
  if (lastCommon.length > 0) {
    score += Math.min(20, lastCommon.length * 10);
  }

  // 4. 位置邻近度（+30）
  const proximityScore = Math.max(0, 30 - anchorDistance * 3);
  score += proximityScore;

  // 5. 内容活性（+10）
  const nonEmptyOld = oldLines.filter(l => l.trim().length > 0);
  if (nonEmptyOld.length > 0) {
    score += 10;
  }

  return Math.min(150, score);
}

/**
 * 智能定位用户意图的真实行号范围
 *
 * 流程：
 * 1. 读取用户锚点位置的内容作为参考上下文
 * 2. 在 [anchor-N, anchor+N] 滑动窗口内评分每个候选位置
 * 3. 最高分超过阈值 → 返回修正行号
 * 4. 低于阈值 → 保持用户原行号
 */
export async function smartLocate(
  filePath: string,
  options: LocateOptions,
): Promise<LocateResult> {
  const {
    anchorStart,
    anchorEnd,
    fileLines,
    newLines,
    radius = 10,
    operation,
  } = options;

  const totalLines = fileLines.length;
  const newFeatures = extractFeatures(newLines);

  if (newLines.length === 0) return {
    matched: false,
    startLine: anchorStart,
    endLine: anchorEnd,
    confidence: 0,
    message: '新内容为空，跳过定位',
  };

  const windowStart = Math.max(1, anchorStart - radius);
  const windowEnd = Math.min(totalLines, anchorEnd + radius);

  if (operation === 'add') {
    return {
      matched: false,
      startLine: anchorStart,
      endLine: anchorEnd,
      confidence: 0,
      message: '插入操作无需定位',
    };
  }

  if (operation === 'del') {
    return {
      matched: false,
      startLine: anchorStart,
      endLine: anchorEnd,
      confidence: 0,
      message: '无匹配（删除操作，原位置可能有内容，保持行号）',
    };
  }

  // ── modify 操作 ──
  // 用新内容的特征反向搜索：
  //   1. 在窗口内独立匹配首行 → 定位 bestStartLine
  //   2. 在窗口内独立匹配末行 → 定位 bestEndLine
  //   3. 两者之差决定了替换范围（拉伸/收缩自动适应新行数）
  let bestStartScore = 0;
  let bestStartLine = anchorStart;

  for (let pos = windowStart; pos <= windowEnd; pos++) {
    const oldLine = fileLines[pos - 1];
    if (!oldLine) continue;
    const anchorDistance = Math.abs(pos - anchorStart);
    const firstLineFeatures = {
      baseIndent: newFeatures.baseIndent,
      lastIndent: newFeatures.lastIndent,
      firstLineTokens: newFeatures.firstLineTokens,
      lastLineTokens: newFeatures.firstLineTokens,
      lineCount: 1,
      nonEmptyCount: newLines[0]?.trim().length ? 1 : 0,
    };
    const score = scoreCandidate([oldLine], firstLineFeatures, anchorDistance, 'first');
    if (score > bestStartScore) {
      bestStartScore = score;
      bestStartLine = pos;
    }
  }

  // 单行替换时末尾 = 起始
  let bestEndLine = bestStartLine;
  let bestEndScore = bestStartScore;

  if (newLines.length > 1) {
    bestEndLine = anchorEnd;
    bestEndScore = 0;

    for (let pos = windowStart; pos <= windowEnd; pos++) {
      const oldLine = fileLines[pos - 1];
      if (!oldLine) continue;
      const anchorDistance = Math.abs(pos - anchorEnd);
      const lastLineFeatures = {
        baseIndent: newFeatures.lastIndent,
        lastIndent: newFeatures.lastIndent,
        firstLineTokens: newFeatures.lastLineTokens,
        lastLineTokens: newFeatures.lastLineTokens,
        lineCount: 1,
        nonEmptyCount: 1,
      };
      const score = scoreCandidate([oldLine], lastLineFeatures, anchorDistance, 'last');
      if (score > bestEndScore) {
        bestEndScore = score;
        bestEndLine = pos;
      }
    }

    // 确保 start <= end
    if (bestStartLine > bestEndLine) {
      const tmp = bestStartLine;
      bestStartLine = bestEndLine;
      bestEndLine = tmp;
      const tmpScore = bestStartScore;
      bestStartScore = bestEndScore;
      bestEndScore = tmpScore;
    }
  }

  // 阈值判断
  const THRESHOLD = 60;
  const hasMoved = bestStartLine !== anchorStart || bestEndLine !== anchorEnd;
  const bestScore = Math.min(bestStartScore, bestEndScore);
  if (bestScore >= THRESHOLD && hasMoved) {
    return {
      matched: true,
      startLine: bestStartLine,
      endLine: bestEndLine,
      confidence: bestScore,
      message: `已自动修正行号 ${anchorStart}-${anchorEnd} → ${bestStartLine}-${bestEndLine}（${newLines.length} 行替换原 ${anchorEnd - anchorStart + 1} 行，置信度 ${bestScore}/150）`,
    };
  } else if (bestScore >= THRESHOLD && !hasMoved) {
    return {
      matched: true,
      startLine: bestStartLine,
      endLine: bestEndLine,
      confidence: bestScore,
      message: `行号 ${bestStartLine}-${bestEndLine} 位置已确认（置信度 ${bestScore}/150）`,
    };
  }
  return {
    matched: false,
    startLine: anchorStart,
    endLine: anchorEnd,
    confidence: bestScore,
    message: `未找到高置信度匹配（最佳得分 ${bestScore}/${THRESHOLD}），保持用户行号`,
  };
}

