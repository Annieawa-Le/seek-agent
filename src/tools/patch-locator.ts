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

  // 基准缩进：取首个非空行的缩进
  const firstNonEmpty = nonEmpty[0] || '';
  const indentMatch = firstNonEmpty.match(/^(\s*)/);
  const baseIndent = indentMatch ? indentMatch[1].length : 0;

  // 结构化 token：提取关键词、括号、关键字
  const extractTokens = (line: string): string[] => {
    const tokens: string[] = [];
    // 提取开头的关键字（function, if, for, const, let, var, return, class, import, export, interface 等）
    const keywordMatch = line.trim().match(/^(\w+)\b/);
    if (keywordMatch) tokens.push(keywordMatch[1]);
    // 提取结尾符号
    const trimmed = line.trim();
    if (trimmed.endsWith('{')) tokens.push('{');
    if (trimmed.endsWith('}')) tokens.push('}');
    if (trimmed.endsWith(';')) tokens.push(';');
    if (trimmed.endsWith(')')) tokens.push(')');
    if (trimmed.endsWith('(')) tokens.push('(');
    // 提取 =、=>、: 等操作符
    if (trimmed.includes('=>')) tokens.push('arrow');
    if (trimmed.includes('=') && !trimmed.includes('==') && !trimmed.includes('===')) tokens.push('assign');
    if (trimmed.includes(':')) tokens.push('colon');
    // 提取字符串/模板字面量
    if (trimmed.includes('`')) tokens.push('template');
    return tokens;
  };

  return {
    baseIndent,
    firstLineTokens: lines.length > 0 ? extractTokens(lines[0]) : [],
    lastLineTokens: lines.length > 0 ? extractTokens(lines[lines.length - 1]) : [],
    lineCount: lines.length,
    nonEmptyCount: nonEmpty.length,
  };
}

/**
 * 计算两个特征之间的相似度得分（0-150）
 */
function scoreCandidate(
  oldLines: string[],
  newFeatures: ReturnType<typeof extractFeatures>,
  anchorDistance: number,
): number {
  if (oldLines.length === 0) return 0;

  let score = 0;

  // 1. 同源行数检查（+40）
  // 如果 old 和 new 行数完全一致，很可能是同位置修改
  if (oldLines.length === newFeatures.lineCount) {
    score += 40;
  } else if (Math.abs(oldLines.length - newFeatures.lineCount) <= 2) {
    // 差 1-2 行也还行
    score += 20;
  }
  // 2. 基准缩进匹配（+60 / +10 / +0）
  // 单行匹配时缩进是最强区分信号，完全一致得高分，稍有偏差就大幅扣分
  const oldFirstLine = oldLines.find(l => l.trim().length > 0);
  if (oldFirstLine) {
    const oldIndent = oldFirstLine.match(/^(\s*)/)?.[1].length ?? 0;
    const indentDiff = Math.abs(oldIndent - newFeatures.baseIndent);
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

  // 首行 token 匹配
  const oldFirstTokens = extractOldTokens(oldLines[0]);
  const firstCommon = oldFirstTokens.filter(t => newFeatures.firstLineTokens.includes(t));
  if (firstCommon.length > 0) {
    score += Math.min(20, firstCommon.length * 10);
  }

  // 末行 token 匹配
  const oldLastTokens = extractOldTokens(oldLines[oldLines.length - 1]);
  const lastCommon = oldLastTokens.filter(t => newFeatures.lastLineTokens.includes(t));
  if (lastCommon.length > 0) {
    score += Math.min(20, lastCommon.length * 10);
  }

  // 4. 位置邻近度（+30）
  // anchorDistance = 0 时得 30 分，每远 1 行扣 3 分
  const proximityScore = Math.max(0, 30 - anchorDistance * 3);
  score += proximityScore;

  // 5. 内容活性（+10）：old 应该有有意义的内容
  const nonEmptyOld = oldLines.filter(l => l.trim().length > 0);
  if (nonEmptyOld.length > 0) {
    score += 10;
  }

  return score;
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

  // 如果新旧行数相同且新内容为空，不处理
  if (newLines.length === 0) return {
    matched: false,
    startLine: anchorStart,
    endLine: anchorEnd,
    confidence: 0,
    message: '新内容为空，跳过定位',
  };

  // 搜索窗口 = [anchorStart - radius, anchorEnd + radius]
  // 但要保证窗口不越界
  const windowStart = Math.max(1, anchorStart - radius);
  const windowEnd = Math.min(totalLines, anchorEnd + radius);

  // 需要匹配的行数 = 用户要修改的范围长度

  if (operation === 'add') {
    // add 没有"旧内容"可匹配，只做位置合理性检查
    return {
      matched: false,
      startLine: anchorStart,
      endLine: anchorEnd,
      confidence: 0,
      message: '插入操作无需定位',
    };
  }

  // del 操作：用目标范围的内容和对应半径匹配
  // 但 del 没有 replaceLines，所以用空行数 + 位置邻近度做简化匹配
  if (operation === 'del') {
    return {
      matched: false,
      startLine: anchorStart,
      endLine: anchorEnd,
      confidence: 0,
      message: '无匹配（删除操作，原位置可能有内容，保持行号）',
    };
  }

  // modify 操作：用新内容的特征反向搜索
  // 分别匹配首行和尾行，然后拉伸范围
  let bestStartScore = 0;
  let bestEndScore = 0;
  let bestStartLine = anchorStart;
  let bestEndLine = anchorEnd;

  // 首行匹配：在窗口内找与新内容首行最匹配的行
  for (let pos = windowStart; pos <= windowEnd; pos++) {
    const oldLine = fileLines[pos - 1];
    if (!oldLine) continue;
    const anchorDistance = Math.abs(pos - anchorStart);
    // 用新内容首行的特征来匹配单行
    const firstLineFeatures = {
      baseIndent: newFeatures.baseIndent,
      firstLineTokens: newFeatures.firstLineTokens,
      lastLineTokens: newFeatures.firstLineTokens,
      lineCount: 1,
      nonEmptyCount: oldLine.trim().length > 0 ? 1 : 0,
    };
    const score = scoreCandidate([oldLine], firstLineFeatures, anchorDistance);
    if (score > bestStartScore) {
      bestStartScore = score;
      bestStartLine = pos;
    }
  }

  // 尾行匹配：在窗口内找与新内容末行最匹配的行
  if (newLines.length > 1) {
    const lastLineFeatures = {
      baseIndent: newFeatures.baseIndent,
      firstLineTokens: newFeatures.lastLineTokens,
      lastLineTokens: newFeatures.lastLineTokens,
      lineCount: 1,
      nonEmptyCount: 1,
    };
    for (let pos = windowStart; pos <= windowEnd; pos++) {
      const oldLine = fileLines[pos - 1];
      if (!oldLine) continue;
      const anchorDistance = Math.abs(pos - anchorEnd);
      const score = scoreCandidate([oldLine], lastLineFeatures, anchorDistance);
      if (score > bestEndScore) {
        bestEndScore = score;
        bestEndLine = pos;
      }
    }
  } else {
    // 单行替换：首尾相同
    bestEndLine = bestStartLine;
    bestEndScore = bestStartScore;
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

  // 阈值判断
  const CONFIDENCE_THRESHOLD = 60;
  const hasMoved = bestStartLine !== anchorStart || bestEndLine !== anchorEnd;
  const bestScore = Math.min(bestStartScore, bestEndScore);
  if (bestScore >= CONFIDENCE_THRESHOLD && hasMoved) {
    return {
      matched: true,
      startLine: bestStartLine,
      endLine: bestEndLine,
      confidence: bestScore,
      message: `已自动修正行号 ${anchorStart}-${anchorEnd} → ${bestStartLine}-${bestEndLine}（拉伸 ${newLines.length} 行替换原 ${anchorEnd - anchorStart + 1} 行，置信度 ${bestScore}/150）`,
    };
  } else if (bestScore >= CONFIDENCE_THRESHOLD && !hasMoved) {
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
    message: `未找到高置信度匹配（最佳得分 ${bestScore}/${CONFIDENCE_THRESHOLD}），保持用户行号`,
  };
}



