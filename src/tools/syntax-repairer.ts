/**
 * syntax-repairer.ts — 自动语法修复引擎
 *
 * 当 patch 操作（add/del/modify）导致语法检查失败时，
 * 在「影响区域」内分析括号平衡，尝试自动修复。
 *
 * 设计原则：
 * - 只修改影响区域 ± radius 范围内的内容
 * - 优先移除多余括号（安全），其次补全缺失括号
 * - 每步修复后立即语法检查验证，通过即停止
 * - 不修改不确定的内容，宁可不修复也不引入新问题
 */

import { checkSyntax } from './syntax-validator.js';

// ============================================================
// 类型定义
// ============================================================

export interface AutoRepairResult {
  /** 是否成功修复 */
  repaired: boolean;
  /** 修复后的行数组（未修复时是原内容） */
  newLines: string[];
  /** 修复描述 */
  description: string;
  /** 具体的修复操作列表 */
  changes: RepairChange[];
}

export interface RepairChange {
  type: 'remove-line' | 'add-line' | 'modify-line';
  line: number;
  oldText?: string;
  newText?: string;
  description: string;
}

interface BraceAnalysis {
  /** 净深度（{ 数 - } 数）>0 说明缺 }，<0 说明多 } */
  netBalance: number;
  /** 搜索范围内所有孤立的闭括号位置 */
  extraClosings: Array<{ globalLine: number; char: string; text: string }>;
  /** 搜索范围内所有可能缺失闭括号的位置 */
  missingClosings: Array<{ globalLine: number; indent: string }>;
  /** 是否明显是平衡的 */
  balanced: boolean;
}

// ============================================================
// 主入口
// ============================================================

const DEFAULT_RADIUS = 10;
const MAX_ATTEMPTS = 6;

/**
 * 在文件修改后尝试自动修复因括号不平衡导致的语法错误。
 *
 * @param filePath    - 文件路径（用于 checkSyntax 推断语言类型）
 * @param newLines    - 修改后的完整行数组
 * @param affectedRange - 修改直接影响的行范围（1-based）
 * @param lineEnding  - 换行符
 * @param hasTrailingNewline - 是否末尾有换行
 * @param options     - 可选参数
 */
export function autoRepair(
  filePath: string,
  newLines: string[],
  affectedRange: { start: number; end: number },
  lineEnding: '\n' | '\r\n',
  hasTrailingNewline: boolean,
  options?: {
    radius?: number;
  },
): AutoRepairResult {
  const radius = options?.radius ?? DEFAULT_RADIUS;
  const changes: RepairChange[] = [];

  let { start: affStart, end: affEnd } = affectedRange;
  if (affStart < 1) affStart = 1;
  if (affEnd > newLines.length) affEnd = newLines.length;
  if (affStart > affEnd) affStart = affEnd;

  // 搜索范围：影响区域 ± radius
  const searchStart = Math.max(1, affStart - radius);
  const searchEnd = Math.min(newLines.length, affEnd + radius);

  // 分析括号平衡
  const balance = analyzeBraceBalance(newLines, searchStart, searchEnd, affStart, affEnd);

  if (balance.balanced) {
    return {
      repaired: false,
      newLines,
      description: '影响区域内括号已平衡，无需修复',
      changes: [],
    };
  }

  let current = [...newLines];
  let attemptCount = 0;

  // ── 策略 1: 移除多余的孤立闭括号行（最安全） ──
  if (balance.extraClosings.length > 0) {
    // 只处理影响区域内的多余闭括号（±2 行宽容）
    const innerThreshold = radius - 2;
    const closingsInRange = balance.extraClosings.filter(
      p => p.globalLine >= affStart - innerThreshold && p.globalLine <= affEnd + innerThreshold,
    );
    // 如果影响区域内没有，再扩大到整个搜索范围
    const candidates = closingsInRange.length > 0 ? closingsInRange : balance.extraClosings;

    // 从后向前尝试（避免行号偏移），每次只移除一个
    const sorted = [...candidates].sort((a, b) => b.globalLine - a.globalLine);
    for (const pos of sorted) {
      if (attemptCount >= MAX_ATTEMPTS) break;

      // 只处理整行只有闭括号/空白/分号/逗号的情况
      const trimmed = pos.text.trim();
      const isIsolatedBrace = /^[}\])][,;]?$/.test(trimmed);
      if (!isIsolatedBrace) continue;

      const testLines = [...current];
      testLines.splice(pos.globalLine - 1, 1);
      const content = testLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const check = checkSyntax(filePath, content);
      if (check.ok) {
        current = testLines;
        changes.push({
          type: 'remove-line',
          line: pos.globalLine,
          oldText: pos.text,
          description: `移除了多余的闭括号行（行 ${pos.globalLine}）`,
        });
        attemptCount++;
        break; // 一次只做一个修复
      }
    }

    if (changes.length > 0) {
      return {
        repaired: true,
        newLines: current,
        description: `自动修复：${changes.map(c => c.description).join('；')}`,
        changes,
      };
    }
  }

  // ── 策略 2: 尝试移除行尾多余的单个闭括号 ──
  // 比如 "  return foo;}" 这样的行，末尾多了一个 }
  if (balance.netBalance < 0) {
    // 在影响区域附近检查行尾有多余闭括号的行
    for (let line = affStart; line <= Math.min(newLines.length, affEnd + 3); line++) {
      if (attemptCount >= MAX_ATTEMPTS) break;
      const lineContent = current[line - 1];
      if (!lineContent) continue;

      // 检查行尾是否有多余的闭括号（如末尾的 } 前面没有对应的 { 在同一行）
      const match = lineContent.match(/^(\s*.*?)([}\])]+)\s*$/);
      if (!match) continue;

      const [, body, trailingBraces] = match;
      // 只处理末尾是单个闭括号且前面不是开括号的情况
      if (trailingBraces.length !== 1) continue;
      if (body.trimEnd().endsWith('{') || body.trimEnd().endsWith('(')) continue;

      const testLines = [...current];
      testLines[line - 1] = body.trimEnd();
      const content = testLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const check = checkSyntax(filePath, content);
      if (check.ok) {
        current = testLines;
        changes.push({
          type: 'modify-line',
          line,
          oldText: lineContent,
          newText: body.trimEnd(),
          description: `移除了行 ${line} 末尾多余的 '${trailingBraces}'`,
        });
        attemptCount++;
        break;
      }
    }

    if (changes.length > 0) {
      return {
        repaired: true,
        newLines: current,
        description: `自动修复：${changes.map(c => c.description).join('；')}`,
        changes,
      };
    }
  }

  // ── 策略 3: 补全缺失的闭括号（在影响区域末尾或自然位置） ──
  if (balance.netBalance > 0) {
    const deficit = balance.netBalance; // 缺少的 } 数量

    // 找到合适的插入位置：影响区域结束后的位置，或在影响区域内最后一个缩进位置
    const insertLine = findInsertLine(current, affStart, affEnd, radius);
    const indent = guessIndent(current, insertLine);

    for (let i = 0; i < Math.min(deficit, 3) && attemptCount < MAX_ATTEMPTS; i++) {
      const testLines = [...current];
      testLines.splice(insertLine - 1 + i, 0, `${indent}}`);
      const content = testLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const check = checkSyntax(filePath, content);
      if (check.ok) {
        current = testLines;
        changes.push({
          type: 'add-line',
          line: insertLine + i,
          newText: `${indent}}`,
          description: `补全了缺失的 '}'（行 ${insertLine + i}）`,
        });
        attemptCount++;
      } else {
        // 如果当前位置不行，尝试其他位置
        break;
      }
    }

    if (changes.length > 0) {
      return {
        repaired: true,
        newLines: current,
        description: `自动修复：${changes.map(c => c.description).join('；')}`,
        changes,
      };
    }
  }

  // ── 策略 4: 强力修复 — 重新平衡整个搜索范围 ──
  // 当简单策略都失败时，对整个搜索范围做全局括号重平衡
  if (balance.netBalance !== 0) {
    const result = rebalanceZone(current, searchStart, searchEnd, balance.netBalance, filePath, lineEnding, hasTrailingNewline);
    if (result) {
      return {
        repaired: true,
        newLines: result.lines,
        description: `自动修复：${result.description}`,
        changes: result.changes,
      };
    }
  }

  return {
    repaired: false,
    newLines: current,
    description: '自动修复失败：无法安全地修正括号平衡',
    changes: [],
  };
}

// ============================================================
// 括号分析
// ============================================================

/**
 * 分析在 [searchStart, searchEnd] 范围内的括号平衡。
 * 同时根据影响区域 [affStart, affEnd] 确定哪些括号可能是多余的/缺失的。
 */
function analyzeBraceBalance(
  lines: string[],
  searchStart: number,
  searchEnd: number,
  affStart: number,
  affEnd: number,
): BraceAnalysis {
  // 先计算从文件头到 searchStart-1 的基线深度
  let baseDepth = 0;
  for (let i = 0; i < searchStart - 1; i++) {
    baseDepth += countBraceDelta(lines[i]);
  }

  let depth = baseDepth;
  let minDepth = depth;
  const extraClosings: BraceAnalysis['extraClosings'] = [];
  const potentialMissing: BraceAnalysis['missingClosings'] = [];

  for (let line = searchStart; line <= searchEnd; line++) {
    const text = lines[line - 1];
    const lineDelta = countBraceDelta(text);
    const newDepth = depth + lineDelta;

    // 记录：如果 depth 当前 > 0 然后 newDepth 降到 <= depth，说明这里可能有匹配
    // 如果 depth 已经是 0 然后遇到了 }，这就是多余的闭括号
    if (lineDelta < 0 && depth === 0) {
      extraClosings.push({
        globalLine: line,
        char: '}',
        text,
      });
    }

    // 分析行内容：整行都是闭括号的记录下来作为候选
    const trimmed = text.trim();
    if (/^[}\])]/.test(trimmed) && depth <= 1) {
      // 这一行以闭括号开头且在低深度，可能是多余的
      // 但别重复添加已经确认的
      if (!extraClosings.find(e => e.globalLine === line)) {
        extraClosings.push({
          globalLine: line,
          char: trimmed[0],
          text,
        });
      }
    }

    depth = newDepth;
    if (depth < minDepth) minDepth = depth;
  }

  // 修正：minDepth 如果是负数，说明搜索范围内多出了闭括号
  // 绝对的多余闭括号数 = -minDepth（如果 minDepth < 0）
  // 净平衡 = 搜索范围结束时的深度 - 起始深度
  const endDepth = depth;
  const netBalance = endDepth - baseDepth;

  // 提取可能缺括号的位置：缩进级别较高的行尾
  for (let line = affStart; line <= Math.min(affEnd + 2, lines.length); line++) {
    const text = lines[line - 1];
    const trimmed = text.trimEnd();
    // 如果一行以 { 结尾或包含未闭合的块，说明这里可能需要闭括号
    if (trimmed.endsWith('{') || trimmed.endsWith('(')) {
      const indent = text.match(/^(\s*)/)?.[1] ?? '';
      potentialMissing.push({ globalLine: line, indent });
    }
  }
  // 如果影响区域内没有明显的块起始行，取影响区域末尾
  if (potentialMissing.length === 0) {
    const endLine = Math.min(affEnd, lines.length);
    const indent = guessIndent(lines, endLine);
    potentialMissing.push({ globalLine: endLine, indent });
  }

  return {
    netBalance,
    extraClosings,
    missingClosings: potentialMissing,
    balanced: netBalance === 0 && extraClosings.length === 0,
  };
}

// ============================================================
// 括号重平衡（策略 4）
// ============================================================

function rebalanceZone(
  lines: string[],
  searchStart: number,
  searchEnd: number,
  netBalance: number,
  filePath: string,
  lineEnding: '\n' | '\r\n',
  hasTrailingNewline: boolean,
): { lines: string[]; description: string; changes: RepairChange[] } | null {
  const changes: RepairChange[] = [];
  let current = [...lines];

  if (netBalance < 0) {
    // 有多余的闭括号：从搜索范围末尾向前扫描，移除孤立的闭括号行
    const count = -netBalance;
    let removed = 0;
    for (let line = searchEnd; line >= searchStart && removed < count; line--) {
      const text = current[line - 1];
      const trimmed = text.trim();
      if (/^[}\])][,;]?$/.test(trimmed)) {
        current.splice(line - 1, 1);
        changes.push({
          type: 'remove-line',
          line,
          oldText: text,
          description: `移除多余的 '${trimmed[0]}'`,
        });
        removed++;
      }
    }
    if (removed > 0) {
      const content = current.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const check = checkSyntax(filePath, content);
      if (check.ok) {
        return { lines: current, description: `重平衡：移除了 ${removed} 个多余闭括号`, changes };
      }
    }
  } else if (netBalance > 0) {
    // 缺少闭括号：在搜索范围末尾补上
    const count = Math.min(netBalance, 3);
    const insertLine = searchEnd + 1;
    const indent = guessIndent(current, searchEnd);
    for (let i = 0; i < count; i++) {
      current.splice(insertLine - 1 + i, 0, `${indent}}`);
      changes.push({
        type: 'add-line',
        line: insertLine + i,
        newText: `${indent}}`,
        description: `补全缺失的 '}'`,
      });
    }
    const content = current.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
    const check = checkSyntax(filePath, content);
    if (check.ok) {
      return { lines: current, description: `重平衡：补全了 ${count} 个缺失闭括号`, changes };
    }
  }

  return null;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 计算一行文本对括号深度的影响（{ 和 } 的差值）
 */
function countBraceDelta(line: string): number {
  let delta = 0;
  let inString = false;
  let stringChar = '';
  let inTemplate = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    // 字符串状态
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') inTemplate = false;
      if (ch === '$' && next === '{') { i++; continue; }
      continue;
    }

    // 进入字符串
    if (ch === "'" || ch === '"') { inString = true; stringChar = ch; continue; }
    if (ch === '`') { inTemplate = true; continue; }

    // 注释跳过
    if (ch === '/' && next === '/') break;
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < line.length - 1 && !(line[i] === '*' && line[i + 1] === '/')) i++;
      i++;
      continue;
    }

    // 计括号
    if (ch === '{') delta++;
    if (ch === '}') delta--;
  }

  return delta;
}

/**
 * 找到补全闭括号的合适插入行
 */
function findInsertLine(
  lines: string[],
  _affStart: number,
  affEnd: number,
  radius: number,
): number {
  // 优先：在影响区域末尾之后，缩进最小的位置
  const candidateStart = Math.min(affEnd + 1, lines.length);
  const candidateEnd = Math.min(lines.length, affEnd + radius);

  // 在候选范围内找缩进最小的行（通常是闭合块的位置）
  let bestLine = candidateStart;
  let bestIndent = Infinity;

  for (let line = candidateStart; line <= candidateEnd; line++) {
    const text = lines[line - 1];
    if (text.trim().length === 0) continue;
    const indent = text.match(/^(\s*)/)?.[1].length ?? 0;
    // 闭括号行通常缩进较小
    if (text.trim().startsWith('}') || text.trim().startsWith(')') || text.trim().startsWith(']')) {
      if (indent < bestIndent) {
        bestIndent = indent;
        bestLine = line;
      }
    }
  }

  // 如果没找到闭括号行，就用影响区域末尾
  if (bestIndent === Infinity) {
    bestLine = Math.min(affEnd + 1, lines.length);
  }

  return bestLine;
}

/**
 * 猜测某行应使用的缩进
 */
function guessIndent(lines: string[], lineIndex: number): string {
  // 1. 看上一行的缩进
  for (let i = lineIndex - 1; i >= 0; i--) {
    const text = lines[i];
    if (text.trim().length > 0) {
      const indent = text.match(/^(\s*)/)?.[1] ?? '';
      // 如果上一行以 { 结尾，增加一级缩进
      if (text.trimEnd().endsWith('{')) {
        return indent + '  ';
      }
      return indent;
    }
  }
  return '';
}




