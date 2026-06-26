/**
 * patch-diff.ts — 行级 unified diff 生成器
 *
 * 纯算法实现，无外部依赖。使用简单的 LCS 算法在行级别计算差异。
 * 输出标准 unified diff 格式（与 `git diff` 兼容）。
 */

// ── LCS 求最长公共子序列 ──
function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function backtrackDiff(a: string[], b: string[], dp: number[][]): { type: 'eq' | 'del' | 'add'; line: string }[] {
  const ops: { type: 'eq' | 'del' | 'add'; line: string }[] = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: 'eq', line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', line: b[j - 1] });
      j--;
    } else {
      ops.push({ type: 'del', line: a[i - 1] });
      i--;
    }
  }
  return ops.reverse();
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { type: 'eq' | 'del' | 'add'; line: string }[];
}

/**
 * 生成 unified diff（文件名使用原路径名）
 *
 * @param oldLines - 修改前的行数组
 * @param newLines - 修改后的行数组
 * @param oldName - 修改前文件名（默认 'a/file'）
 * @param newName - 修改后文件名（默认 'b/file'）
 * @param contextLines - 上下文行数（默认 3）
 * @returns unified diff 字符串
 */
export function generateDiff(
  oldLines: string[],
  newLines: string[],
  oldName = 'a/file',
  newName = 'b/file',
  contextLines = 3,
): string {
  const dp = lcsMatrix(oldLines, newLines);
  const ops = backtrackDiff(oldLines, newLines, dp);

  // 如果没有变化，返回空
  if (ops.every(op => op.type === 'eq')) return '';

  // 分割成 hunks
  const hunks: Hunk[] = [];
  let currentHunk: { type: 'eq' | 'del' | 'add'; line: string }[] | null = null;
  let hunkOldStart = 1, hunkNewStart = 1;
  let oldIdx = 0, newIdx = 0;

  for (const op of ops) {
    if (op.type === 'eq') {
      if (currentHunk === null) {
        // 在 hunk 外，跳过 contextLines 以外的行
        if (hunks.length === 0 || hunks.length > 0) {
          // 延迟处理：先看后面是否还有变化
          currentHunk = [{ type: 'eq', line: op.line }];
          oldIdx++; newIdx++;
          // 初始化起始位置（需要减去前面的 eq 计数）
          // 实际会在形成 hunk 时修正
          continue;
        }
      } else {
        // 在 hunk 内
        currentHunk.push({ type: 'eq', line: op.line });
        oldIdx++; newIdx++;
        // 检查是否已经积累了足够多的上下文行可以关闭 hunk
        const eqCount = currentHunk.filter(l => l.type === 'eq').length;
        if (eqCount >= contextLines * 2 + 1) {
          // 找到最后一个 'eq' 的位置，保留 contextLines 行
          const eqIndices: number[] = [];
          for (let i = 0; i < currentHunk.length; i++) {
            if (currentHunk[i].type === 'eq') eqIndices.push(i);
          }
          const keepHead = contextLines;
          const keepTail = contextLines;
          if (eqIndices.length >= keepHead + keepTail) {
            const splitIdx = eqIndices[eqIndices.length - keepTail];
            // 保留前 keepHead 条 eq 和后 keepTail 条 eq
            const firstEQI = eqIndices[keepHead];
            if (firstEQI < splitIdx) {
              // 截断中间部分
              const head = currentHunk.slice(0, firstEQI);
              const tail = currentHunk.slice(splitIdx);
              currentHunk = [...head, ...tail];
            }
          }
        }
        continue;
      }
    } else {
      // del 或 add
      if (currentHunk === null) {
        // 开始新 hunk
        const eqBefore = ops.slice(0, ops.indexOf(op)).filter(o => o.type === 'eq').length;
        hunkOldStart = oldIdx + 1 - Math.min(contextLines, oldIdx);
        hunkNewStart = newIdx + 1 - Math.min(contextLines, newIdx);
        currentHunk = [];
        // 添加前面的上下文行
        // 从 ops 中往回找 contextLines 行 eq
        let ctxNeeded = contextLines;
        const ctxOps: { type: 'eq'; line: string }[] = [];
        const idx = ops.indexOf(op);
        for (let k = idx - 1; k >= 0 && ctxNeeded > 0; k--) {
          if (ops[k].type === 'eq') {
            ctxOps.unshift({ type: 'eq', line: ops[k].line });
            ctxNeeded--;
          }
        }
        currentHunk.push(...ctxOps);
        currentHunk.push(op);
      } else {
        currentHunk.push(op);
      }
      if (op.type === 'del') oldIdx++;
      if (op.type === 'add') newIdx++;
    }
  }

  // 收集所有 hunk
  // 简化实现：使用简单的 hunks 分割策略
  const entries: { type: 'eq' | 'del' | 'add'; line: string }[] = [];

  // 更直接的 hunk 生成方式
  // 用滑动窗口找到变化段
  let i = 0;
  while (i < ops.length) {
    // 跳过纯 eq 段
    if (ops[i].type === 'eq') {
      i++;
      continue;
    }

    // 找到一个变化段：[i ... j-1]
    const hunkStart = i;
    while (i < ops.length && ops[i].type !== 'eq') i++;
    const changeEnd = i;

    // 扩展上下文：向左取 contextLines 行 eq
    let ctxLeft = contextLines;
    const hunkLines: { type: 'eq' | 'del' | 'add'; line: string }[] = [];
    for (let k = hunkStart - 1; k >= 0 && ctxLeft > 0 && ops[k].type === 'eq'; k--) {
      hunkLines.unshift(ops[k]);
      ctxLeft--;
    }

    // 变化行
    for (let k = hunkStart; k < changeEnd; k++) {
      hunkLines.push(ops[k]);
    }

    // 向右取 contextLines 行 eq
    let ctxRight = contextLines;
    for (let k = changeEnd; k < ops.length && ctxRight > 0 && ops[k].type === 'eq'; k++) {
      hunkLines.push(ops[k]);
      ctxRight--;
    }

    // 计算行号
    const oldDelCount = hunkLines.filter(l => l.type === 'del').length;
    const newAddCount = hunkLines.filter(l => l.type === 'add').length;

    // 计算 hunk 起始行号
    let oStart = 1, nStart = 1;
    let oIdx = 0, nIdx = 0;
    for (const op of ops) {
      if (op === hunkLines[0]) break;
      if (op.type === 'eq' || op.type === 'del') oIdx++;
      if (op.type === 'eq' || op.type === 'add') nIdx++;
    }
    oStart = oIdx + 1 - hunkLines.slice(0, hunkLines.findIndex(l => l.type !== 'eq')).length;
    nStart = nIdx + 1 - hunkLines.slice(0, hunkLines.findIndex(l => l.type !== 'eq')).length;
    if (oStart < 1) oStart = 1;
    if (nStart < 1) nStart = 1;

    const oldCount = hunkLines.filter(l => l.type !== 'add').length;
    const newCount = hunkLines.filter(l => l.type !== 'del').length;

    hunks.push({
      oldStart: oStart,
      oldCount,
      newStart: nStart,
      newCount,
      lines: [...hunkLines],
    });
  }

  // 如果是空的或有误，回退到简单方法
  if (hunks.length === 0) {
    // 兜底：整个文件作为一块
    const oldCount = oldLines.length;
    const newCount = newLines.length;
    return `--- ${oldName}\n+++ ${newName}\n@@ -1,${oldCount} +1,${newCount} @@\n` +
      ops.map(op => {
        switch (op.type) {
          case 'eq': return ` ${op.line}`;
          case 'del': return `-${op.line}`;
          case 'add': return `+${op.line}`;
        }
      }).join('\n');
  }

  // 组装 diff
  const parts: string[] = [`--- ${oldName}`, `+++ ${newName}`];
  for (const hunk of hunks) {
    const oRange = hunk.oldCount === 1
      ? `${hunk.oldStart}`
      : `${hunk.oldStart},${hunk.oldCount}`;
    const nRange = hunk.newCount === 1
      ? `${hunk.newStart}`
      : `${hunk.newStart},${hunk.newCount}`;
    parts.push(`@@ -${oRange} +${nRange} @@`);
    for (const line of hunk.lines) {
      switch (line.type) {
        case 'eq': parts.push(` ${line.line}`); break;
        case 'del': parts.push(`-${line.line}`); break;
        case 'add': parts.push(`+${line.line}`); break;
      }
    }
  }

  return parts.join('\n');
}

/**
 * 更简单可靠的行级 diff，适合 patch 预览
 * 基于逐行对比的高效实现
 */
export function generateSimpleDiff(
  oldLines: string[],
  newLines: string[],
): string {
  const maxLen = Math.max(oldLines.length, newLines.length);
  const lines: string[] = [];
  let hasChanges = false;

  const minLen = Math.min(oldLines.length, newLines.length);
  let i = 0;

  // 前向跳过相同行
  for (; i < minLen; i++) {
    if (oldLines[i] !== newLines[i]) break;
  }

  // 反向跳过相同行
  let j = oldLines.length - 1;
  let k = newLines.length - 1;
  for (; j >= i && k >= i; j--, k--) {
    if (oldLines[j] !== newLines[k]) break;
  }

  // 前段上下文
  const ctxStart = Math.max(0, i - 2);
  for (let idx = ctxStart; idx < i; idx++) {
    lines.push(` ${oldLines[idx]}`);
  }

  // 变化段
  for (let idx = i; idx <= j; idx++) {
    lines.push(`-${oldLines[idx]}`);
    hasChanges = true;
  }
  for (let idx = i; idx <= k; idx++) {
    lines.push(`+${newLines[idx]}`);
    hasChanges = true;
  }

  // 后段上下文
  const ctxEnd = Math.min(newLines.length, k + 3);
  for (let idx = k + 1; idx < ctxEnd; idx++) {
    lines.push(` ${newLines[idx]}`);
  }

  if (!hasChanges) return '';

  return lines.join('\n');
}
