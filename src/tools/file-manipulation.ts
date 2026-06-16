import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { resolvePath, assertPathInWorkspace } from '../workdir.js';
import { patchStaging, PendingPatch } from './patch-staging';


// ============================================================
// 公共辅助函数
// ============================================================

/**
 * 读取文件并返回行数组、是否以换行符结尾、以及原始行尾符类型（\n 或 \r\n）
 */
async function readFileLines(
  filePath: string
): Promise<{
  lines: string[];
  hasTrailingNewline: boolean;
  lineEnding: '\n' | '\r\n';
}> {
  const content = await fs.readFile(filePath, 'utf8');
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const hasTrailingNewline = content.endsWith('\n') || content.endsWith('\r\n');
  if (lines.length === 1 && lines[0] === '') {
    return { lines: [], hasTrailingNewline, lineEnding };
  }
  return { lines, hasTrailingNewline, lineEnding };
}

/**
 * 将行数组写回文件，保留原换行符风格和末尾换行符特性
 */
async function writeFileLines(
  filePath: string,
  lines: string[],
  hasTrailingNewline: boolean,
  lineEnding: '\n' | '\r\n'
): Promise<void> {
  let content = lines.join(lineEnding);
  if (hasTrailingNewline && lines.length > 0) {
    content += lineEnding;
  }
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * 合并重叠或相邻的区间（要求区间已排序且为 0‑based）
 */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const merged: [number, number][] = [];
  let [curStart, curEnd] = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const [nextStart, nextEnd] = ranges[i];
    if (nextStart <= curEnd + 1) {
      curEnd = Math.max(curEnd, nextEnd);
    } else {
      merged.push([curStart, curEnd]);
      [curStart, curEnd] = [nextStart, nextEnd];
    }
  }
  merged.push([curStart, curEnd]);
  return merged;
}

// ============================================================
// 行号重叠检测辅助函数
// ============================================================

function rangesIntersect(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function getPatchRanges(
  patch: { type: string; params: Record<string, any> },
  forOverlap: boolean
): [number, number][] {
  switch (patch.type) {
    case 'add': {
      const { lineIndex } = patch.params as { lineIndex: number };
      if (lineIndex === -1) return [];
      if (forOverlap) return [[lineIndex, lineIndex]];
      return [[lineIndex, lineIndex]];
    }
    case 'del': {
      return (patch.params as { lineIndex: [number, number][] }).lineIndex;
    }
    case 'modify': {
      const { startLine, endLine } = patch.params as { startLine: number; endLine: number };
      return [[startLine, endLine]];
    }
    default:
      return [];
  }
}

function patchesConflict(
  a: { type: string; params: Record<string, any> },
  b: { type: string; params: Record<string, any> }
): boolean {
  if (a.type === 'add' && b.type === 'add') {
    const aLine = (a.params as { lineIndex: number }).lineIndex;
    const bLine = (b.params as { lineIndex: number }).lineIndex;
    const isValidLine = (val: any): val is number => typeof val === 'number' && !isNaN(val);
    if (!isValidLine(aLine) || !isValidLine(bLine)) return false;
    if (aLine === -1 || bLine === -1) return false;
    return aLine === bLine;
  }
  if (a.type === 'add' || b.type === 'add') return false;

  const aRanges = getPatchRanges(a, true);
  const bRanges = getPatchRanges(b, true);
  if (!Array.isArray(aRanges) || aRanges.length === 0) return false;
  if (!Array.isArray(bRanges) || bRanges.length === 0) return false;

  for (const [aS, aE] of aRanges) {
    for (const [bS, bE] of bRanges) {
      if (rangesIntersect(aS, aE, bS, bE)) return true;
    }
  }
  return false;
}

function patchTypeLabel(p: { type: string }): string {
  switch (p.type) {
    case 'add': return '插入操作';
    case 'del': return '删除操作';
    case 'modify': return '修改操作';
    default: return p.type;
  }
}

function formatRange(start: number, end: number): string {
  return start === end ? `行 ${start}` : `行 ${start}-${end}`;
}

/**
 * 检查新的 patch 是否与暂存区中已有的 patch 发生冲突
 * 返回冲突描述信息（无冲突时返回空字符串）
 */
function checkConflict(
  newPatch: { type: 'add' | 'del' | 'modify'; params: Record<string, any> },
  existingPatches: PendingPatch[]
): string {
  for (const existing of existingPatches) {
    if (patchesConflict(newPatch, existing)) {
      const newRanges = getPatchRanges(newPatch, true);
      const existingRanges = getPatchRanges(existing, true);
      let conflictInfo = '';
      for (const [ns, ne] of newRanges) {
        for (const [es, ee] of existingRanges) {
          if (rangesIntersect(ns, ne, es, ee)) {
            conflictInfo = `${patchTypeLabel(newPatch)} ${formatRange(ns, ne)} 与已有的${patchTypeLabel(existing)} ${formatRange(es, ee)}`;
            break;
          }
          if (conflictInfo) break;
        }
      }
      return `行号冲突！请先确认修改（${conflictInfo} 冲突）`;
    }
  }
  return '';
}

function autoCleanBeforeNewPatch(): { cleared: boolean; message: string } {
  const result = patchStaging.autoClearStaleIfNeeded();
  if (result.hasStale || result.cleared > 0) {
    return {
      cleared: true,
      message: `🧹 检测到 ${result.cleared} 个过期/残留的暂存修改，已自动清理。`
    };
  }
  return { cleared: false, message: '' };
}

function getCurrentSessionPatches(filePath: string): PendingPatch[] {
  const currentSessionId = patchStaging.getSessionId();
  return patchStaging.getByFile(filePath).filter(p => p.sessionId === currentSessionId);
}

// ============================================================
// ── 批次管理 ──
// ============================================================

/**
 * 按 resume 标记将 patch 列表分成多个批次。
 * 批次 0: 开头 → 第一个 resume 之前（不含 resume 自身）
 * 批次 1: 第一个 resume → 第二个 resume 之前（含 resume）
 * 批次 N: 第 N 个 resume → 末尾（含 resume）
 */
function groupIntoBatches(patches: PendingPatch[]): PendingPatch[][] {
  if (patches.length === 0) return [];
  const batches: PendingPatch[][] = [];
  let current: PendingPatch[] = [patches[0]];
  for (let i = 1; i < patches.length; i++) {
    if (patches[i].resume) {
      batches.push(current);
      current = [patches[i]];
    } else {
      current.push(patches[i]);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 找出现有 patches 中最后一个 resume 之后的所有 patch（即新 resume=false patch 所在的批次成员） */
function getCurrentBatchPatches(existing: PendingPatch[]): PendingPatch[] {
  // 从后往前找最后一个 resume=true 的位置
  let lastResumeIdx = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    if (existing[i].resume) { lastResumeIdx = i; break; }
  }
  // 如果没有 resume，返回全部（batch 0）
  if (lastResumeIdx === -1) return existing;
  return existing.slice(lastResumeIdx);
}

/**
 * 获取单个 patch 的排序分量，用于从底部向上处理
 */
function getPatchSortComponents(patch: PendingPatch): { baseLine: number; priority: number } {
  switch (patch.type) {
    case 'modify': {
      const { startLine } = patch.params as { startLine: number };
      return { baseLine: startLine, priority: 0 };
    }
    case 'del': {
      const { lineIndex } = patch.params as { lineIndex: [number, number][] };
      const minStart = Math.min(...lineIndex.map(([s]) => s));
      return { baseLine: minStart, priority: 1 };
    }
    case 'add': {
      const { lineIndex } = patch.params as { lineIndex: number };
      return { baseLine: lineIndex === -1 ? Infinity : lineIndex, priority: 2 };
    }
    default:
      return { baseLine: 0, priority: 99 };
  }
}

function validatePatchLines(patch: PendingPatch, totalLines: number): string {
  switch (patch.type) {
    case 'add': {
      const { lineIndex } = patch.params as { lineIndex: number };
      if (lineIndex !== -1 && (lineIndex < 1 || lineIndex > totalLines + 1)) {
        return `插入行号 ${lineIndex} 超出文件范围（文件共 ${totalLines} 行）`;
      }
      return '';
    }
    case 'del': {
      const { lineIndex } = patch.params as { lineIndex: [number, number][] };
      for (const [start, end] of lineIndex) {
        if (start < 1 || end > totalLines) {
          return `删除范围 [${start}, ${end}] 超出文件范围（文件共 ${totalLines} 行）`;
        }
      }
      return '';
    }
    case 'modify': {
      const { startLine, endLine } = patch.params as { startLine: number; endLine: number };
      if (startLine < 1 || endLine > totalLines) {
        return `修改范围 [${startLine}, ${endLine}] 超出文件范围（文件共 ${totalLines} 行）`;
      }
      return '';
    }
    default:
      return '';
  }
}

/**
 * 将一个批次内的 patch 应用到行数组。
 * 同一批次内的 patch 按 baseLine 降序排列后逐个应用（均基于批次开始的同一份 lines）。
 */
function applyBatchToLines(batch: PendingPatch[], lines: string[]): { lines: string[]; results: string[] } {
  const results: string[] = [];
  const sorted = [...batch].sort((a, b) => {
    const compA = getPatchSortComponents(a);
    const compB = getPatchSortComponents(b);
    if (compB.baseLine !== compA.baseLine) return compB.baseLine - compA.baseLine;
    return compA.priority - compB.priority;
  });

  const originalTotal = lines.length;
  let currentLines = [...lines];

  for (const patch of sorted) {
    const { type } = patch;
    try {
      switch (type) {
        case 'add': {
          const { lineIndex, Lines } = patch.params as { lineIndex: number; Lines: string[] };
          const insertIndex = lineIndex === -1 ? currentLines.length : lineIndex - 1;
          currentLines = [...currentLines.slice(0, insertIndex), ...Lines, ...currentLines.slice(insertIndex)];
          results.push(`  ✅ 已应用：[ADD] ${lineIndex === -1 ? '追加到末尾' : `在第 ${lineIndex} 行前插入`} ${Lines.length} 行`);
          break;
        }
        case 'del': {
          const { lineIndex } = patch.params as { lineIndex: [number, number][] };
          const zeroBased = lineIndex
            .map(([s, e]) => [s - 1, e - 1] as [number, number])
            .sort((a, b) => a[0] - b[0]);
          const merged = mergeRanges(zeroBased);
          let newLines: string[] = [];
          let pos = 0;
          let deletedCount = 0;
          for (const [s, e] of merged) {
            newLines.push(...currentLines.slice(pos, s));
            deletedCount += e - s + 1;
            pos = e + 1;
          }
          newLines.push(...currentLines.slice(pos));
          currentLines = newLines;
          results.push(`  ✅ 已应用：[DEL] 删除 ${deletedCount} 行`);
          break;
        }
        case 'modify': {
          const { startLine, endLine, replaceLines } = patch.params as {
            startLine: number; endLine: number; replaceLines: string[];
          };
          const si = startLine - 1, ei = endLine - 1;
          currentLines = [...currentLines.slice(0, si), ...replaceLines, ...currentLines.slice(ei + 1)];
          results.push(`  ✅ 已应用：[MODIFY] 替换行 ${startLine}-${endLine}（${replaceLines.length} 行）`);
          break;
        }
      }
    } catch (err: any) {
      results.push(`  ❌ 应用失败 [${type}]: ${err.message}`);
    }
  }

  results.push(`  （行数: ${originalTotal} → ${currentLines.length} 行）`);
  return { lines: currentLines, results };
}

// ============================================================
// 核心：带批次感知的批量应用
// ============================================================

/**
 * 将同一个文件的所有暂存补丁按批次应用到磁盘。
 *
 * 批次划分规则：
 *   - 所有 patch 按添加顺序排列
 *   - 遇到 resume=true 的 patch 时，之前的所有 patch 为一批，此 patch 开始新一批
 *   - 每批内的 patch 从底部向上处理（基于该批开始时的文件状态）
 *   - 批次之间顺序叠加（批 N 的输出是批 N+1 的输入）
 */
export async function applyPatchesToFile(
  filePath: string,
  patches: PendingPatch[]
): Promise<string[]> {
  const { lines: originalLines, hasTrailingNewline, lineEnding } = await readFileLines(filePath);
  const allResults: string[] = [];

  const batches = groupIntoBatches(patches);
  let currentLines = [...originalLines];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    // 验证该批的每个 patch 是否在当前文件状态中合法
    const valid: PendingPatch[] = [];
    for (const p of batch) {
      const err = validatePatchLines(p, currentLines.length);
      if (err) {
        allResults.push(`  ❌ 跳过 [${p.type.toUpperCase()}]: ${err}`);
      } else {
        valid.push(p);
      }
    }
    if (valid.length === 0) continue;

    if (bi > 0) {
      allResults.push(`  ── 批次 ${bi + 1}（resume）──`);
    }

    const result = applyBatchToLines(valid, currentLines);
    currentLines = result.lines;
    allResults.push(...result.results);
  }

  await writeFileLines(filePath, currentLines, hasTrailingNewline, lineEnding);
  allResults.push(`  💾 已写入文件：${filePath}（${originalLines.length} → ${currentLines.length} 行）`);

  return allResults;
}

// ============================================================
// 预览辅助：模拟所有先前 patch 后的文件状态
// ============================================================

/**
 * 获取用于预览的基准行数组。
 * - resume=false → 直接读取原始文件
 * - resume=true  → 模拟暂存区中当前文件所有先前 patch（按批次）后的状态
 */
async function getPreviewBaseLines(
  filePath: string,
  resume: boolean,
  priorPatches: PendingPatch[],
): Promise<{ lines: string[]; batchResults: string[] }> {
  const { lines: originalLines } = await readFileLines(filePath);
  if (!resume || priorPatches.length === 0) {
    return { lines: originalLines, batchResults: [] };
  }

  const batches = groupIntoBatches(priorPatches);
  let currentLines = [...originalLines];
  const batchResults: string[] = [];

  for (const batch of batches) {
    // 跳过无效 patch 的验证（预览时只模拟有效部分）
    const valid: PendingPatch[] = [];
    for (const p of batch) {
      if (!validatePatchLines(p, currentLines.length)) {
        valid.push(p);
      }
    }
    if (valid.length === 0) continue;
    const result = applyBatchToLines(valid, currentLines);
    currentLines = result.lines;
    batchResults.push(...result.results);
  }

  return { lines: currentLines, batchResults };
}


// ============================================================
// 1. create_file - 创建新文件
// ============================================================
export const createFile = tool({
  description: `创建一个新文件，并写入 fileContent。
  filePath 是目录的绝对路径或相对当前工作目录的路径，fileName 是需要创建的文件名（包括扩展名）。
  这是独占的写入方式（文件已存在会报错）。注意：此工具直接执行，不会进入暂存区。`,
  inputSchema: z.object({
    filePath: z.string().describe('目录的绝对路径或相对当前工作目录的路径'),
    fileName: z.string().describe('需要创建的文件名（包括扩展名）'),
    fileContent: z.string().describe('要写入的文件内容'),
  }),
  execute: async ({ filePath, fileName, fileContent }): Promise<string> => {
    try {
      const targetPath = path.join(resolvePath(filePath), fileName);
      assertPathInWorkspace(targetPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const fileHandle = await fs.open(targetPath, 'wx');
      await fileHandle.writeFile(fileContent, 'utf8');
      await fileHandle.close();
      return `✅ 文件创建成功：${targetPath}\n📝 写入内容长度：${fileContent.length} 字符`;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        return `文件已创建 ${path.join(resolvePath(filePath), fileName)}`;
      }
      return `❌ 创建失败：${error.message}`;
    }
  },
});

export const replaceFile = tool({
  description: `向一个文件中写入 fileContent。
  filePath 是文件的绝对路径或相对当前工作目录的路径，会替换原本的所有内容。
  这是非独占的写入方式。注意：此工具直接执行，不会进入暂存区。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    fileContent: z.string().describe('要写入的文件内容'),
  }),
  execute: async ({ filePath, fileContent }): Promise<string> => {
    try {
      const targetPath = resolvePath(filePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const fileHandle = await fs.open(targetPath, 'w');
      await fileHandle.writeFile(fileContent, 'utf8');
      await fileHandle.close();
      return `✅ 写入成功：${targetPath}\n📝 写入内容长度：${fileContent.length} 字符`;
    } catch (error: any) {
      return `❌ 写入失败：${error.message}`;
    }
  },
});


// ============================================================
// ── 通用：为三种 patch 工具构造 execute 逻辑 ──
// ============================================================

/**
 * 构建 add_patch / del_patch / modify_patch 通用的执行体。
 * toolType / params / schemaParams 用于区分三种类型的差异，
 * 公共逻辑（自动清理、冲突检测、预览生成、暂存）复写一次。
 */
async function executePatch(
  toolType: 'add' | 'del' | 'modify',
  params: Record<string, any>,
  schemaParams: { description: string; resolvedPath: string; rawFilePath: string },
): Promise<string> {
  const { rawFilePath, resolvedPath, description } = schemaParams;
  const resume = params.resume === true;

  // 自动清理过期残留
  const cleanResult = autoCleanBeforeNewPatch();
  const existingPatches = getCurrentSessionPatches(resolvedPath);

  // 冲突检测：resume=true 的开始新批次，不与任何已有 patch 冲突
  // resume=false 的只与本批次内（最后一个 resume 之后）的 patch 对比
  let conflictMsg = '';
  if (!resume) {
    const sameBatch = getCurrentBatchPatches(existingPatches);
    conflictMsg = checkConflict(
      { type: toolType, params },
      sameBatch,
    );
  }

  // 去重检测（仅同类型同参数）
  const existingSame = existingPatches.find(p => {
    if (p.type !== toolType) return false;
    if (p.resume !== resume) return false;
    // 简化：只比较入参的 JSON
    return JSON.stringify(p.params) === JSON.stringify({ ...params, resume: undefined });
  });

  if (existingSame) {
    let msg = `（已添加的将要进行：）\n${existingSame.description}`;
    msg += `\n■ 暂存区现有 ${patchStaging.size} 个待应用的修改`;
    return msg;
  }

  let result = '';
  let patchAdded = false;

  if (!conflictMsg) {
    patchAdded = true;
    const patchParams = { ...params };
    delete patchParams.resume;
    const patch: PendingPatch = {
      type: toolType,
      rawFilePath,
      resolvedPath,
      description,
      params: patchParams,
      createdAt: Date.now(),
      sessionId: patchStaging.getSessionId(),
      resume,
    };
    patchStaging.add(patch);

    result = '';
    if (cleanResult.cleared) {
      result += `${cleanResult.message}\n`;
    }
    result += `📥 [#${patchStaging.size}] 已添加到暂存区 [${toolType.toUpperCase()}] ${description}`;
    if (resume) result += '（续批模式）';
    result += `\n📄 文件：${resolvedPath}\n`;
  }

  // ── 预览生成 ──
  let afterStr = '';
  try {
    // 获取基准行（resume=true 时模拟先前所有 patch）
    const baseInfo = await getPreviewBaseLines(resolvedPath, resume, existingPatches);
    const baseLines = baseInfo.lines;
    const { lines: fileLines } = await readFileLines(resolvedPath);

    if (baseLines.length > 0 || toolType === 'add') {
      switch (toolType) {
        case 'add': {
          const { lineIndex, Lines } = params as { lineIndex: number; Lines: string[] };
          const simulated = [...baseLines];
          const insertIdx = lineIndex === -1 ? simulated.length : lineIndex - 1;
          simulated.splice(insertIdx, 0, ...Lines);

          // 基于原始文件行号决定上下文范围
          const origCtxStart = lineIndex === -1
            ? Math.max(1, fileLines.length - 2)
            : Math.max(1, lineIndex - 2);
          const origCtxEnd = lineIndex === -1
            ? fileLines.length
            : Math.min(fileLines.length, lineIndex + 2);
          const previewStart = Math.max(0, origCtxStart - 1);
          const previewEnd = Math.min(simulated.length, origCtxEnd + Lines.length);

          const showLines: string[] = [];
          for (let i = previewStart; i < previewEnd; i++) {
            const origLineNum = i + 1;
            const isInserted = lineIndex === -1
              ? i >= fileLines.length
              : i >= lineIndex - 1 && i < lineIndex - 1 + Lines.length;
            const marker = isInserted ? `\x1b[32m>\x1b[0m\x1b[30m` : ' ';
            showLines.push(`  ${marker} ${origLineNum}. ${simulated[i]}`);
          }
          afterStr += `\n📄 修改后（> 标记新插入的行）：\n${showLines.join('\n')}`;
          break;
        }

        case 'del': {
          const { lineIndex } = params as { lineIndex: [number, number][] };
          const sortedRanges = [...lineIndex].sort((a, b) => a[0] - b[0]);
          const mergedRanges: [number, number][] = [];
          for (const [s, e] of sortedRanges) {
            if (mergedRanges.length === 0 || s > mergedRanges[mergedRanges.length - 1][1] + 1) {
              mergedRanges.push([s, e]);
            } else {
              mergedRanges[mergedRanges.length - 1][1] = Math.max(mergedRanges[mergedRanges.length - 1][1], e);
            }
          }
          const firstDel = mergedRanges[0][0];
          const lastDel = mergedRanges[mergedRanges.length - 1][1];
          const ctxStart = Math.max(1, firstDel - 2);
          const ctxEnd = Math.min(fileLines.length, lastDel + 2);

          const simulated = [...baseLines];
          const zeroBasedRanges = mergedRanges.map(([s, e]) => [s - 1, e - 1] as [number, number]).sort((a, b) => b[0] - a[0]);
          for (const [s, e] of zeroBasedRanges) {
            simulated.splice(s, e - s + 1);
          }

          const deletedBefore = (origLine: number) => {
            let count = 0;
            for (const [s, e] of mergedRanges) { if (e < origLine) count += e - s + 1; }
            return count;
          };
          const showLines: string[] = [];
          for (let i = ctxStart; i <= ctxEnd; i++) {
            const inDelRange = mergedRanges.some(([s, e]) => i >= s && i <= e);
            if (inDelRange) {
              showLines.push(`  \x1b[31m×\x1b[0m\x1b[30m ${i}. ${fileLines[i - 1]}`);
            } else {
              const newIdx = i - 1 - deletedBefore(i);
              showLines.push(`    ${i}. ${simulated[newIdx]}`);
            }
          }
          afterStr += `\n📄 修改后（× 标记将被删除的行）：\n${showLines.join('\n')}`;
          break;
        }

        case 'modify': {
          const { startLine, endLine, replaceLines } = params as {
            startLine: number; endLine: number; replaceLines: string[];
          };
          const ctxStart = Math.max(1, startLine - 2);
          const ctxEnd = Math.min(fileLines.length, endLine + 2);
          const simulated = [...baseLines];
          simulated.splice(startLine - 1, endLine - startLine + 1, ...replaceLines);

          const showLines: string[] = [];
          for (let i = ctxStart; i <= ctxEnd; i++) {
            const inModRange = i >= startLine && i <= endLine;
            if (inModRange) {
              showLines.push(`  \x1b[33m~\x1b[0m\x1b[30m ${i}. ${fileLines[i - 1]}`);
            } else {
              const newIdx = (i < startLine) ? i - 1 : i - 1 + replaceLines.length - (endLine - startLine + 1);
              showLines.push(`    ${i}. ${simulated[newIdx]}`);
            }
          }
          showLines.push(`  --- 替换为以下 ${replaceLines.length} 行 ---`);
          for (let j = 0; j < replaceLines.length; j++) {
            showLines.push(`  \x1b[33m>\x1b[0m\x1b[30m ${startLine + j}. ${replaceLines[j]}`);
          }
          afterStr += `\n📄 修改后（~ 标记被替换的行，> 标记新内容）：\n${showLines.join('\n')}`;
          break;
        }
      }
    }
  } catch {
    // 预览失败不影响主流程
  }

  if (afterStr) result += afterStr;
  result += `\n■ 操作尚未应用！请调用 ensure_patch 来确认或放弃。`;
  result += `\n■ 暂存区现有 ${patchStaging.size} 个待应用的修改`;
  if (patchAdded) patchStaging.setLastResultMessage(result);
  return result;
}


// ============================================================
// 2. add_patch
// ============================================================
export const addPatch = tool({
  description: `向暂存区添加"插入内容"操作。暂存区中的修改不会立即应用到文件，
  需要等待调用 ensure_patch 工具后才会实际写入文件。

  filePath 是文件的绝对路径或相对当前工作目录的路径。
  lineIndex 是要插入的行号（插入后位置位于指定行号之前，-1 表示在末尾追加，行号从 1 开始）。
  Lines 是字符串列表，即需要流式写入的内容。
  resume 为 true 时行号基于前一次 patch 改完后的文件，并与之前 patch 分属不同批次。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    lineIndex: z.number().int().describe('插入的行号（-1 表示追加到末尾，行号从 1 开始）'),
    Lines: z.array(z.string()).describe('要插入的内容行列表'),
    resume: z.boolean().optional().default(false).describe('续批模式：行号基于前一个 patch 改完后的文件'),
  }),
  execute: async ({ filePath, lineIndex, Lines, resume }): Promise<string> => {
    if (!filePath?.trim()) return '❌ 错误：文件路径不能为空';
    if (!Lines?.length) return '❌ 错误：写入内容不能为空';

    const resolvedPath = resolvePath(filePath);
    const description = lineIndex === -1
      ? `在末尾追加 ${Lines.length} 行`
      : `在第 ${lineIndex} 行前插入 ${Lines.length} 行`;

    return executePatch('add', { lineIndex, Lines, resume }, { description, resolvedPath, rawFilePath: filePath });
  },
});

// ============================================================
// 3. del_patch
// ============================================================
export const delPatch = tool({
  description: `向暂存区添加"删除行"操作。暂存区中的修改不会立即应用到文件，
  需要等待调用 ensure_patch 工具后才会实际写入文件。

  filePath 是文件的绝对路径或相对当前工作目录的路径。
  lineIndex 是要删除的行，形式为整数列表的列表。
  例如要删除 57 到 89 行、101 行，则：[[57,89],[101,101]]，行号从 1 开始。
  resume 为 true 时行号基于前一次 patch 改完后的文件，并与之前 patch 分属不同批次。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    lineIndex: z
      .array(z.array(z.number().int()))
      .describe('要删除的行范围列表，格式 [[start,end], ...]，行号从 1 开始'),
    resume: z.boolean().optional().default(false).describe('续批模式：行号基于前一个 patch 改完后的文件'),
  }),
  execute: async ({ filePath, lineIndex, resume }): Promise<string> => {
    if (!filePath?.trim()) return '❌ 错误：文件路径不能为空';
    if (!lineIndex?.length) return '❌ 错误：删除范围不能为空';

    for (const range of lineIndex) {
      if (!Array.isArray(range) || range.length !== 2) {
        return `❌ 错误：删除范围格式不正确，应为 [start, end]，实际为：${JSON.stringify(range)}`;
      }
      const [start, end] = range;
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return `❌ 错误：行号必须是整数，当前为 [${start}, ${end}]`;
      }
      if (start < 1 || end < 1) return `❌ 错误：行号必须 >= 1，当前为 [${start}, ${end}]`;
      if (start > end) return `❌ 错误：起始行 ${start} 不能大于结束行 ${end}`;
    }

    const resolvedPath = resolvePath(filePath);
    let totalDeleteCount = 0;
    const deletedInfo: string[] = [];
    for (const [start, end] of lineIndex) {
      totalDeleteCount += end - start + 1;
      deletedInfo.push(start === end ? `行 ${start}` : `行 ${start}-${end}`);
    }
    const description = `删除 ${totalDeleteCount} 行（${deletedInfo.join('、')}）`;

    return executePatch('del', { lineIndex, resume }, { description, resolvedPath, rawFilePath: filePath });
  },
});

// ============================================================
// 4. modify_patch
// ============================================================
export const modifyPatch = tool({
  description: `向暂存区添加"修改行"操作。暂存区中的修改不会立即应用到文件，
  需要等待调用 ensure_patch 工具后才会实际写入文件。

  将文件中 [startLine, endLine] 范围内的行替换为 replaceLines 中的内容。
  行号从 1 开始。
  resume 为 true 时行号基于前一次 patch 改完后的文件，并与之前 patch 分属不同批次。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    startLine: z.number().int().describe('要替换的起始行号（从 1 开始）'),
    endLine: z.number().int().describe('要替换的结束行号（从 1 开始，包含该行）'),
    replaceLines: z.array(z.string()).describe('替换后的新内容行列表'),
    resume: z.boolean().optional().default(false).describe('续批模式：行号基于前一个 patch 改完后的文件'),
  }),
  execute: async ({ filePath, startLine, endLine, replaceLines, resume }): Promise<string> => {
    if (!filePath?.trim()) return '❌ 错误：文件路径为空，可能是后面的替换行字符串中存在转义导致。请检查';
    if (!Array.isArray(replaceLines)) return '❌ 错误：replaceLines 必须是字符串数组';

    const resolvedPath = resolvePath(filePath);
    const description = `替换行 ${startLine}-${endLine}（共 ${endLine - startLine + 1} 行）→ 替换为 ${replaceLines.length} 行新内容`;

    return executePatch('modify', { startLine, endLine, replaceLines, resume }, { description, resolvedPath, rawFilePath: filePath });
  },
});


// ============================================================
// 5. ensure_patch - 应用或放弃所有暂存的修改
// ============================================================
export const ensurePatch = tool({
  description: `应用或放弃暂存区中的所有修改。
  在调用 add_patch、del_patch、modify_patch 后，修改不会立即生效，
  而是暂存在内存中。调用此工具并设置 apply=true 将把所有暂存的修改实际写入文件；
  设置 apply=false 将放弃所有暂存的修改。

  特别说明：如果同一个文件有多个待应用的修改，系统会自动按批次分组。
  批次之间按顺序叠加（前一批次的输出是后一批次的输入），
  同一批次内的 patch 按从文件底部向上的顺序处理。`,
  inputSchema: z.object({
    apply: z.boolean().describe('true - 应用所有暂存的修改到原文件；false - 放弃所有暂存的修改'),
  }),
  execute: async ({ apply }): Promise<string> => {
    if (patchStaging.isEmpty() && apply) {
      return '📭 暂存区已为空！此前的修改已应用。';
    } else if (patchStaging.isEmpty()) {
      return '📭 暂存区已清空！';
    }

    if (!apply) {
      const count = patchStaging.size;
      patchStaging.clear();
      return `■ 已放弃 ${count} 个暂存的修改。暂存区已清空。`;
    }

    const patches = patchStaging.getAll();
    const allResults: string[] = [];
    let totalFailed = 0;

    const byFile = new Map<string, PendingPatch[]>();
    for (const p of patches) {
      const key = p.resolvedPath;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(p);
    }

    allResults.push(`🔧 开始应用 ${patches.length} 个暂存的修改到 ${byFile.size} 个文件...`);
    allResults.push('');

    let fileIdx = 0;
    for (const [filePath, filePatches] of byFile) {
      fileIdx++;
      // 按添加顺序排序（暂存区本身就是添加顺序）
      const ordered = filePatches.sort((a, b) =>
        (patches.indexOf(a) - patches.indexOf(b))
      );
      allResults.push(`📄 [${fileIdx}/${byFile.size}] 处理文件：${filePath}（${ordered.length} 个补丁）`);

      try {
        const fileResults = await applyPatchesToFile(filePath, ordered);
        allResults.push(...fileResults);
      } catch (err: any) {
        totalFailed += filePatches.length;
        allResults.push(`  ❌ 处理失败：${err.message}`);
      }
      allResults.push('');
    }

    const totalCount = patches.length;
    patchStaging.clear();

    if (totalFailed === 0) {
      allResults.push(`✅ 所有 ${totalCount} 个修改已成功应用。暂存区已清空。`);
    } else {
      allResults.push(`■ 已应用 ${totalCount - totalFailed} 个修改，${totalFailed} 个失败。暂存区已清空。`);
    }

    return allResults.join('\n');
  },
});

// ============================================================
// 6. pop_patch
// ============================================================
export const popPatch = tool({
  description: `从暂存区中弹出最近添加的一个 patch 操作（后进先出）。
  如果暂存区为空，会提示无操作可撤销。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    if (patchStaging.isEmpty()) {
      return '■ 暂存区为空，没有可弹出的操作。';
    }

    const popped = patchStaging.pop();
    if (!popped) {
      return '■ 暂存区为空，没有可弹出的操作。';
    }

    let result = `↩️ 已从暂存区弹出最近的一个操作：\n`;
    result += `  📄 文件：${popped.resolvedPath}\n`;
    result += `  ■ 类型：[${popped.type.toUpperCase()}]\n`;
    result += `  ■ 描述：${popped.description}\n`;
    if (popped.resume) result += `  ■ 模式：续批\n`;
    result += `\n■ 暂存区还有 ${patchStaging.size} 个待应用的修改`;

    return result;
  }
});


// ============================================================
// 7. check_patch
// ============================================================
export const checkPatch = tool({
  description: '查看暂存区中指定序号的 patch 的详细参数和原始返回结果。',
  inputSchema: z.object({
    index: z.number().int().positive().describe('要查看的 patch 序号（从 1 开始）'),
  }),
  execute: async ({ index }) => {
    const patches = patchStaging.getAll();
    if (index < 1 || index > patches.length) {
      return `❌ 序号 ${index} 超出范围，暂存区共有 ${patches.length} 个 patch。`;
    }
    const p = patches[index - 1];
    let result = `📋 第 ${index} 个 patch 详情：\n`;
    result += `工具: ${p.type}\n`;
    result += `文件: ${p.rawFilePath}\n`;
    result += `描述: ${p.description}\n`;
    if (p.resume) result += `模式: 续批 (resume)\n`;
    result += `参数: ${JSON.stringify(p.params, null, 2)}\n`;
    if (p.resultMessage) {
      result += `\n📤 原始返回:\n${p.resultMessage}`;
    } else {
      result += '\n(无原始返回记录)';
    }
    return result;
  },
});

// ============================================================
// 8. revise_patch — 替换指定序号的 patch
// ============================================================
export const revisePatch = tool({
  description: '替换暂存区中指定序号的 patch 为新的 patch 操作。先删除旧的，再添加新的。',
  inputSchema: z.object({
    index: z.number().int().positive().describe('要替换的 patch 序号（从 1 开始）'),
    tool: z.enum(['add_patch', 'del_patch', 'modify_patch']).describe('新的 patch 工具类型'),
    filePath: z.string().describe('文件路径'),
    lineIndex: z.union([z.number().int(), z.array(z.array(z.number().int()))]).optional().describe('add_patch 的行号或 del_patch 的行范围'),
    Lines: z.array(z.string()).optional().describe('(add_patch) 插入的内容行'),
    startLine: z.number().int().optional().describe('(modify_patch) 起始行号'),
    endLine: z.number().int().optional().describe('(modify_patch) 结束行号'),
    replaceLines: z.array(z.string()).optional().describe('(modify_patch) 替换的内容行'),
    resume: z.boolean().optional().describe('续批模式'),
  }),
  execute: async ({ index, tool: toolName, filePath, lineIndex, Lines, startLine, endLine, replaceLines, resume }) => {
    const patches = patchStaging.getAll();
    if (index < 1 || index > patches.length) {
      return `❌ 序号 ${index} 超出范围，暂存区共有 ${patches.length} 个 patch。`;
    }

    const removed = patchStaging.removeAt(index);
    if (!removed) return `❌ 移除序号 ${index} 的 patch 失败。`;

    let desc = '';
    const resolvedPath = resolvePath(filePath);

    switch (toolName) {
      case 'add_patch': {
        const li = (lineIndex as number) ?? -1;
        const lines = Lines ?? [];
        desc = li === -1 ? `在末尾追加 ${lines.length} 行` : `在第 ${li} 行前插入 ${lines.length} 行`;
        patchStaging.add({
          type: 'add', rawFilePath: filePath, resolvedPath,
          description: desc,
          params: { lineIndex: li, Lines: lines },
          createdAt: Date.now(), sessionId: patchStaging.getSessionId(),
          resume: resume ?? false,
        });
        break;
      }
      case 'del_patch': {
        const li = lineIndex as [number, number][];
        if (!li?.length) return '❌ del_patch 需要提供 lineIndex (行范围数组)';
        desc = `删除 ${li.length} 个范围`;
        patchStaging.add({
          type: 'del', rawFilePath: filePath, resolvedPath,
          description: desc,
          params: { lineIndex: li },
          createdAt: Date.now(), sessionId: patchStaging.getSessionId(),
          resume: resume ?? false,
        });
        break;
      }
      case 'modify_patch': {
        const sl = startLine ?? 0;
        const el = endLine ?? 0;
        const rl = replaceLines ?? [];
        desc = `修改行 ${sl}-${el}`;
        patchStaging.add({
          type: 'modify', rawFilePath: filePath, resolvedPath,
          description: desc,
          params: { startLine: sl, endLine: el, replaceLines: rl },
          createdAt: Date.now(), sessionId: patchStaging.getSessionId(),
          resume: resume ?? false,
        });
        break;
      }
    }

    return `✅ 已替换第 ${index} 个 patch 为 [${toolName.toUpperCase()}] ${desc}\n■ 暂存区现有 ${patchStaging.size} 个待应用的修改`;
  },
});



