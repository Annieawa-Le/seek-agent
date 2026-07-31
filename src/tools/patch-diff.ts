/**
 * patch-diff.ts — 行级 diff 生成器
 *
 * 纯算法实现，无外部依赖。提供 patch 预览用的简单逐行对比。
 */

/**
 * 简单可靠的行级 diff，适合 patch 预览
 * 基于逐行对比的高效实现
 */
export function generateSimpleDiff(
  oldLines: string[],
  newLines: string[],
): string {
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


