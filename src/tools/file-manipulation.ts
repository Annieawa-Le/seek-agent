/**
 * file-manipulation.ts — 文件操作工具集
 *
 * ── 设计理念 ──
 * 所有 patch 工具以 diff 作为操作核心载体：
 *   旧内容 + 新内容 → 生成 diff → 持久化到磁盘 → 写入目标文件 → 展示 diff
 *
 * ── 定位策略 ──
 * 默认用用户提供的行号精确操作，不做自动修正。
 * 提供可选的 pretext/endtext 上下文行参数做精准定位：
 *   - 提供 pretext/endtext 时，在 [anchor-radius, anchor+radius] 范围内精确匹配
 *   - 匹配成功 → 按上下文位置操作
 *   - 匹配失败 → 回退到原始行号
 *
 * 工具清单：
 *   create_file     — 创建新文件（独占写入）
 *   replace_file    — 替换文件内容（diff 化 + 持久化）
 *   add_patch       — 在指定位置插入内容（diff 化 + 持久化）
 *   del_patch       — 删除指定行（diff 化 + 持久化）
 *   modify_patch    — 替换指定行内容（diff 化 + 持久化）
 *   undo_patch      — 撤销最近一次文件修改操作
 *   history_patch   — 查看操作历史
 */

import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { resolvePath, assertPathInWorkspace } from '../workdir.js';
import { ToolOutput } from './tool-output';
import type { FileWriteBulk } from './raw-bulk-types.js';
import { undoStack } from './patch-undo.js';
import { contextLocate } from './patch-locator.js';
import { patchBatch } from './patch-batch.js';
import { checkSyntax, formatSyntaxErrors, precheckReplacement } from './syntax-validator.js';

// ============================================================
// 公共辅助函数
// ============================================================

export async function readFileLines(
  filePath: string
): Promise<{
  lines: string[];
  hasTrailingNewline: boolean;
  lineEnding: '\n' | '\r\n';
}> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return { lines: [], hasTrailingNewline: false, lineEnding: '\n' };
  }
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const hasTrailingNewline = content.endsWith('\n') || content.endsWith('\r\n');
  if (lines.length === 1 && lines[0] === '') {
    return { lines: [], hasTrailingNewline, lineEnding };
  }
  return { lines, hasTrailingNewline, lineEnding };
}

async function readFileContent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ============================================================
// 定位辅助函数（普通写盘模式与并行批次暂存模式共用）
// ============================================================

type LocateOk<T> = { ok: true } & T;
type LocateFail = { ok: false; error: string; message: string };
type LocateResult<T> = LocateOk<T> | LocateFail;

/** add_patch 定位：返回 0-based 插入索引（lineIndex=-1 表示末尾） */
function locateAddInsertion(
  fileLines: string[],
  lineIndex: number,
  pretext?: string[],
  endtext?: string[],
): LocateResult<{ insertIndex: number; locateMsg: string; description: string }> {
  let insertIndex = lineIndex === -1 ? fileLines.length : lineIndex;
  let locateMsg = '';

  // 上下文定位模式
  if ((pretext && pretext.length > 0) || (endtext && endtext.length > 0)) {
    const anchorStart = lineIndex === -1 ? fileLines.length : lineIndex;
    const anchorEnd = anchorStart;
    const locateResult = contextLocate(fileLines, pretext, endtext, anchorStart, anchorEnd, 20);
    if (!locateResult.matched) {
      return {
        ok: false,
        error: '上下文匹配失败：' + locateResult.message,
        message: '❌ 错误：上下文匹配失败：' + locateResult.message + '。请修正 pretext/endtext 后重试，或改用 lineIndex 行号模式。',
      };
    }
    if (locateResult.pretextEndLine > 0) {
      insertIndex = locateResult.pretextEndLine - 1;
    } else if (locateResult.endtextStartLine > 0) {
      insertIndex = locateResult.endtextStartLine - 1;
    }
    locateMsg = locateResult.message;
  } else {
    if (lineIndex !== -1 && (lineIndex < 0 || lineIndex > fileLines.length)) {
      return {
        ok: false,
        error: `行号 ${lineIndex} 超出范围`,
        message: `❌ 错误：行号 ${lineIndex} 超出范围（允许 0=开头，1-${fileLines.length}=第 N 行后，-1=末尾追加）`,
      };
    }
  }

  const descLines = lineIndex === -1 ? '文件末尾' : lineIndex === 0 ? '文件开头' : `第 ${lineIndex} 行后`;
  const description = locateMsg
    ? `在${locateMsg}处插入`
    : `在${descLines}插入`;
  return { ok: true, insertIndex, locateMsg, description };
}

/** del_patch 定位：返回 1-based 闭区间列表（已合并去重） */
function locateDelRanges(
  fileLines: string[],
  lineIndex: number[][] | undefined,
  pretext?: string[],
  endtext?: string[],
): LocateResult<{ merged: [number, number][]; description: string }> {
  let merged: [number, number][];
  let description: string;

  // 上下文匹配模式：删除 pretext 和 endtext 之间的内容
  if ((pretext && pretext.length > 0) || (endtext && endtext.length > 0)) {
    // 无可靠行号锚点：全局搜索，不依赖文件中间窗口
    const locateResult = contextLocate(fileLines, pretext, endtext, 1, fileLines.length, 0);
    if (!locateResult.matched) {
      return { ok: false, error: '上下文匹配失败：' + locateResult.message, message: '❌ 错误：上下文匹配失败：' + locateResult.message };
    }
    const delStart = locateResult.pretextEndLine;
    const delEnd = locateResult.endtextStartLine - 1;
    if (delStart > delEnd) {
      return { ok: false, error: 'pretext 和 endtext 之间没有内容可删除', message: '❌ 错误：pretext 和 endtext 之间没有内容可删除' };
    }
    merged = [[delStart, delEnd]];
    const deletedRows = delEnd - delStart + 1;
    description = '删除 pretext 与 endtext 之间的 ' + deletedRows + ' 行（' + locateResult.message + '）';
  } else if (lineIndex && lineIndex.length > 0) {
    // 纯行号模式
    const sorted = [...lineIndex].sort((a, b) => a[0] - b[0]);
    merged = [];
    for (const [s, e] of sorted) {
      if (merged.length === 0 || s > merged[merged.length - 1][1] + 1) merged.push([s, e]);
      else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
    for (const [s, e] of merged) {
      if (s < 1 || e > fileLines.length) {
        return { ok: false, error: '范围 [' + s + ', ' + e + '] 超出文件范围', message: '❌ 错误：删除范围 [' + s + ', ' + e + '] 超出文件范围' };
      }
    }
    const deletedInfo = merged.map(([s, e]) => s === e ? '行 ' + s : '行 ' + s + '-' + e).join('、');
    const deletedCount = merged.reduce((sum, [s, e]) => sum + e - s + 1, 0);
    description = '删除 ' + deletedCount + ' 行（' + deletedInfo + '）';
  } else {
    return { ok: false, error: '请提供 lineIndex 或 pretext/endtext 之一', message: '❌ 错误：请提供 lineIndex 或 pretext/endtext 之一' };
  }

  return { ok: true, merged, description };
}

/** modify_patch 定位：返回 1-based 闭区间（上下文模式下替换范围直接包含 pretext/endtext 本身） */
function locateModifyRange(
  fileLines: string[],
  startLine: number,
  endLine: number,
  _replaceLines: string[],
  pretext?: string[],
  endtext?: string[],
): LocateResult<{ actualStart: number; actualEnd: number; locateMessage: string }> {
  let actualStart = startLine;
  let actualEnd = endLine;
  let locateMessage = '';

  // 上下文定位模式：替换范围直接包含 pretext/endtext 全部上下文行
  if ((pretext && pretext.length > 0) || (endtext && endtext.length > 0)) {
    const locateResult = contextLocate(fileLines, pretext, endtext, startLine, endLine, 20);
    if (!locateResult.matched) {
      return {
        ok: false,
        error: '上下文匹配失败：' + locateResult.message,
        message: '❌ 错误：上下文匹配失败：' + locateResult.message + '。请修正 pretext/endtext 后重试，或改用 startLine/endLine 行号模式。',
      };
    }
    const pLen = pretext?.length ?? 0;
    const eLen = endtext?.length ?? 0;
    // pretext 直接纳入替换范围：从 pretext 首行开始
    if (pLen > 0) actualStart = locateResult.pretextEndLine - pLen;
    // endtext 直接纳入替换范围：到 endtext 末行结束
    if (eLen > 0) actualEnd = locateResult.endtextStartLine + eLen - 1;
    // 仅提供一种上下文时，替换该上下文自身所在范围
    if (pLen > 0 && eLen === 0) actualEnd = locateResult.pretextEndLine - 1;
    else if (eLen > 0 && pLen === 0) actualStart = locateResult.endtextStartLine - 1;

    locateMessage = locateResult.message + '（替换范围已包含 pretext/endtext 上下文行）';

    if (actualStart > actualEnd) {
      return { ok: false, error: 'pretext 和 endtext 之间没有内容可替换', message: '❌ 错误：pretext 和 endtext 之间没有内容可替换' };
    }
  }

  // 纯行号模式（不提供上下文时）：精准使用用户行号，不做自动修正
  if (actualStart < 1) actualStart = 1;
  if (actualEnd > fileLines.length) actualEnd = fileLines.length;
  return { ok: true, actualStart, actualEnd, locateMessage };
}

// ============================================================
// 1. create_file
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
  execute: async ({ filePath, fileName, fileContent }) => {
    try {
      const targetPath = path.join(resolvePath(filePath), fileName);
      assertPathInWorkspace(targetPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const fileHandle = await fs.open(targetPath, 'wx');
      await fileHandle.writeFile(fileContent, 'utf8');
      await fileHandle.close();
      const msg = `✅ 文件创建成功：${targetPath}\n📝 写入内容长度：${fileContent.length} 字符`;
      const bulk: FileWriteBulk = { type: 'file-write', action: 'create', filePath: targetPath, fileName, charCount: fileContent.length };
      return new ToolOutput(bulk, msg);
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        const msg = `文件已存在：${path.join(resolvePath(filePath), fileName)}`;
        const bulk: FileWriteBulk = { type: 'file-write', action: 'create', filePath: path.join(resolvePath(filePath), fileName), fileName, charCount: 0, error: msg };
        return new ToolOutput(bulk, msg);
      }
      const errMsg = `❌ 创建失败：${error.message}`;
      const bulk: FileWriteBulk = { type: 'file-write', action: 'create', filePath: path.join(resolvePath(filePath), fileName), fileName, charCount: 0, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});

// ============================================================
// 2. replace_file
// ============================================================
export const replaceFile = tool({
  description: `向一个文件中写入 fileContent。
  filePath 是文件的绝对路径或相对当前工作目录的路径，会替换原本的所有内容。
  force 为 true 时跳过语法检查。注意：此工具直接执行，不会进入暂存区。
  整文件覆写风险高：能局部修改（add_patch / del_patch / modify_patch）时优先局部修改，避免误伤无关代码。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    fileContent: z.string().describe('要写入的文件内容'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, fileContent, force }) => {
    try {
      const targetPath = resolvePath(filePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      const oldContent = await readFileContent(targetPath);
      const oldLines = oldContent ? oldContent.split(/\r?\n/) : [];
      const newLines = fileContent.split(/\r?\n/);
      const { hasTrailingNewline, lineEnding } = await readFileLines(targetPath);

      if (!force) {
        const checkResult = checkSyntax(targetPath, fileContent);
        if (!checkResult.ok) {
          const errMsg = formatSyntaxErrors(checkResult, {
            oldLines, newLines,
            replaceRange: { start: 1, end: newLines.length },
            precheck: precheckReplacement(targetPath, newLines),
          });
          return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: errMsg }, errMsg);
        }
      }

      const record = await undoStack.executeWrite(
        targetPath, 'modify', `覆写文件（${fileContent.length} 字符）`,
        oldLines, newLines, hasTrailingNewline, lineEnding,
        async (nl: string[]) => {
          const content = nl.join(lineEnding) + (hasTrailingNewline && nl.length > 0 ? lineEnding : '');
          await fs.writeFile(targetPath, content, 'utf8');
        },
      );

      let msg = `✅ 写入成功：${targetPath}\n📝 写入内容长度：${fileContent.length} 字符`;
      if (record.diff) msg += `\n\n--- diff ---\n${record.diff}`;
      msg += `\n💡 如需撤销：undo_patch()`;

      const bulk: FileWriteBulk = { type: 'file-write', action: 'replace', filePath: targetPath, charCount: fileContent.length };
      return new ToolOutput(bulk, msg);
    } catch (error: any) {
      const errMsg = `❌ 写入失败：${error.message}`;
      const bulk: FileWriteBulk = { type: 'file-write', action: 'replace', filePath: resolvePath(filePath), charCount: 0, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});

// ============================================================
// 3. add_patch
// ============================================================
export const addPatch = tool({
  description: `在文件中插入内容。以 diff 为核心载体。支持 lineIndex 行号模式或 pretext/endtext 上下文匹配模式。
  嵌套结构（JSX/HTML/三元表达式）优先小步插入，避免一次插入大段易破坏括号/标签平衡的代码。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    lineIndex: z.number().int().describe('在第 N 行之后插入（0=文件开头，N=第 N 行后，-1=末尾追加；行号从 1 开始）'),
    Lines: z.array(z.string()).describe('要插入的内容行列表'),
    pretext: z.array(z.string()).optional().describe('上下文前导行列表。匹配后在其后插入 Lines，与 lineIndex 锚定配合使用'),
    endtext: z.array(z.string()).optional().describe('上下文后续行列表。匹配后在其前插入 Lines，与 lineIndex 锚定配合使用'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, lineIndex, Lines, pretext, endtext, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'add', description: '', error: '文件路径不能为空' }, '❌ 错误：文件路径不能为空');
    if (!Lines?.length) return new ToolOutput({ type: 'patch', action: 'add', description: '', error: '写入内容不能为空' }, '❌ 错误：写入内容不能为空');

    const resolvedPath = resolvePath(filePath);

    // ── 并行批次暂存模式：同批多个 patch 作用于同一文件，只定位 + 入暂存，不写盘 ──
    if (patchBatch.isBatching(resolvedPath)) {
      const batch = patchBatch.getBatch(resolvedPath)!;
      const locate = locateAddInsertion(batch.baseLines, lineIndex, pretext, endtext);
      if (!locate.ok) {
        return new ToolOutput({ type: 'patch', action: 'add', description: '', error: locate.error }, locate.message);
      }
      const seq = patchBatch.stage(resolvedPath, {
        type: 'add',
        insertIndex: locate.insertIndex,
        lines: Lines,
        description: locate.description,
      });
      const stagedMsg = `✅ [ADD 已暂存] ${locate.description} ${Lines.length} 行\n📄 文件：${resolvedPath}\n📦 同批第 ${seq} 个 patch：与同文件其他 patch 从后往前合并应用`;
      return new ToolOutput({ type: 'patch', action: 'add', description: locate.description + '（已暂存）', filePath: resolvedPath }, stagedMsg);
    }

    // ── 普通模式：直接写盘 ──
    const { lines: fileLines, hasTrailingNewline, lineEnding } = await readFileLines(resolvedPath);
    const locate = locateAddInsertion(fileLines, lineIndex, pretext, endtext);
    if (!locate.ok) {
      return new ToolOutput({ type: 'patch', action: 'add', description: '', error: locate.error }, locate.message);
    }
    const { insertIndex, locateMsg } = locate;
    const newLines = [...fileLines.slice(0, insertIndex), ...Lines, ...fileLines.slice(insertIndex)];
    const description = locate.description + ' ' + Lines.length + ' 行';

    if (!force) {
      const newContent = newLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const checkResult = checkSyntax(resolvedPath, newContent);
      if (!checkResult.ok) {
        const insertStart = insertIndex + 1; // newLines 中 1-based
        const errMsg = formatSyntaxErrors(checkResult, {
          oldLines: fileLines, newLines,
          replaceRange: { start: insertStart, end: insertStart + Lines.length - 1 },
          precheck: precheckReplacement(resolvedPath, Lines),
        });
        return new ToolOutput({ type: 'patch', action: 'add', description: '', error: errMsg }, errMsg);
      }
    }

    const record = await undoStack.executeWrite(
      resolvedPath, 'add', description, fileLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = '✅ [ADD] ' + description + '\n📄 文件：' + resolvedPath + '\n📐 行数：' + fileLines.length + ' → ' + newLines.length + '\n';
    msg += '📝 diff 已持久化到：' + record.diffFilePath + '\n';
    if (locateMsg) msg += '🔍 ' + locateMsg + '\n';
    if (record.diff) msg += '\n--- diff ---\n' + record.diff;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'add', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});

// ============================================================
// 4. del_patch
// ============================================================
export const delPatch = tool({
  description: `直接从文件中删除指定行。以 diff 为核心载体。支持 lineIndex 行号模式或 pretext/endtext 上下文匹配模式。
  删除范围越大越容易破坏嵌套结构：JSX/HTML 优先小步删除（一次删一层），删前可用 find_matching_brace / find_matching_label 确认边界。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    lineIndex: z.array(z.array(z.number().int())).optional().describe('要删除的行范围，格式 [[start,end], ...]。与 pretext/endtext 二选一'),
    pretext: z.array(z.string()).optional().describe('上下文前导行列表。删除 pretext 末行后到 endtext 首行前之间的内容（不含 pretext 和 endtext 本身）'),
    endtext: z.array(z.string()).optional().describe('上下文后续行列表。删除 pretext 末行后到 endtext 首行前之间的内容'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, lineIndex, pretext, endtext, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: '文件路径不能为空' }, '❌ 错误：文件路径不能为空');

    const resolvedPath = resolvePath(filePath);

    // ── 并行批次暂存模式：只定位 + 入暂存，不写盘 ──
    if (patchBatch.isBatching(resolvedPath)) {
      const batch = patchBatch.getBatch(resolvedPath)!;
      const locate = locateDelRanges(batch.baseLines, lineIndex, pretext, endtext);
      if (!locate.ok) {
        return new ToolOutput({ type: 'patch', action: 'del', description: '', error: locate.error }, locate.message);
      }
      const seq = patchBatch.stage(resolvedPath, {
        type: 'del',
        ranges: locate.merged,
        description: locate.description,
      });
      const stagedMsg = `✅ [DEL 已暂存] ${locate.description}\n📄 文件：${resolvedPath}\n📦 同批第 ${seq} 个 patch：与同文件其他 patch 从后往前合并应用`;
      return new ToolOutput({ type: 'patch', action: 'del', description: locate.description + '（已暂存）', filePath: resolvedPath }, stagedMsg);
    }

    // ── 普通模式：直接写盘 ──
    const { lines: fileLines, hasTrailingNewline, lineEnding } = await readFileLines(resolvedPath);
    const locate = locateDelRanges(fileLines, lineIndex, pretext, endtext);
    if (!locate.ok) {
      return new ToolOutput({ type: 'patch', action: 'del', description: '', error: locate.error }, locate.message);
    }
    const merged = locate.merged;
    const description = locate.description;

    // 执行删除
    const zeroBased = merged.map(([s, e]) => [s - 1, e - 1] as [number, number]).sort((a, b) => b[0] - a[0]);
    const newLines = [...fileLines];
    let totalDeleted = 0;
    for (const [s, e] of zeroBased) { newLines.splice(s, e - s + 1); totalDeleted += e - s + 1; }

    if (!force) {
      const newContent = newLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const checkResult = checkSyntax(resolvedPath, newContent);
      if (!checkResult.ok) {
        const errMsg = formatSyntaxErrors(checkResult, { oldLines: fileLines, newLines });
        return new ToolOutput({ type: 'patch', action: 'del', description: '', error: errMsg }, errMsg);
      }
    }

    const record = await undoStack.executeWrite(
      resolvedPath, 'del', description, fileLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );
    let msg = '✅ [DEL] ' + description + '\n📄 文件：' + resolvedPath + '\n📐 行数：' + fileLines.length + ' → ' + newLines.length + '\n📝 diff 已持久化到：' + record.diffFilePath + '\n';
    if (record.diff) msg += '\n--- diff ---\n' + record.diff;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'del', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});

// ============================================================
// 5. modify_patch
// ============================================================
export const modifyPatch = tool({
  description: `直接替换文件中指定行的内容。以 diff 为核心载体。支持行号模式或 pretext/endtext 上下文匹配模式（提供上下文时，替换范围包含 pretext/endtext 本身）。
  小步编辑建议：替换范围越大越容易引入括号/标签不平衡（JSX/HTML 尤为明显）。嵌套结构优先拆小步：先精确修改单行，再小范围插入/删除；包裹结构用 wrap_by（花括号）或 wrap_by_label（HTML/JSX 标签）；改前可用 find_matching_brace / find_matching_label 确认括号/标签配对。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    startLine: z.number().int().describe('要替换的起始行号（从 1 开始，提供 pretext/endtext 时作为锚点）'),
    endLine: z.number().int().describe('要替换的结束行号（从 1 开始，包含该行，提供 pretext/endtext 时作为锚点）'),
    replaceLines: z.array(z.string()).describe('替换后的新内容行列表。替换块必须自身括号/标签平衡，末尾闭合符（}、)、</tag>）数量须与旧范围一致'),
    pretext: z.array(z.string()).optional().describe('上下文前导行列表。匹配后，替换范围从 pretext 首行开始（包含 pretext 本身）。与 startLine/endLine 锚定配合使用'),
    endtext: z.array(z.string()).optional().describe('上下文后续行列表。匹配后，替换范围到 endtext 末行结束（包含 endtext 本身）'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, startLine, endLine, replaceLines, pretext, endtext, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: '文件路径为空' }, '❌ 错误：文件路径为空');
    if (!Array.isArray(replaceLines)) return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: 'replaceLines 必须是字符串数组' }, '❌ 错误：replaceLines 必须是字符串数组');

    const resolvedPath = resolvePath(filePath);

    // ── 并行批次暂存模式：只定位 + 入暂存，不写盘 ──
    if (patchBatch.isBatching(resolvedPath)) {
      const batch = patchBatch.getBatch(resolvedPath)!;
      const locate = locateModifyRange(batch.baseLines, startLine, endLine, replaceLines, pretext, endtext);
      if (!locate.ok) {
        return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: locate.error }, locate.message);
      }
      const seq = patchBatch.stage(resolvedPath, {
        type: 'modify',
        startLine: locate.actualStart,
        endLine: locate.actualEnd,
        lines: replaceLines,
        description: '修改行 ' + locate.actualStart + '-' + locate.actualEnd + '（' + replaceLines.length + ' 行）',
      });
      const stagedMsg = `✅ [MODIFY 已暂存] 修改行 ${locate.actualStart}-${locate.actualEnd}（${replaceLines.length} 行）\n📄 文件：${resolvedPath}\n📦 同批第 ${seq} 个 patch：与同文件其他 patch 从后往前合并应用`;
      return new ToolOutput({ type: 'patch', action: 'modify', description: '修改行 ' + locate.actualStart + '-' + locate.actualEnd + '（已暂存）', filePath: resolvedPath }, stagedMsg);
    }

    // ── 普通模式：直接写盘 ──
    const { lines: fileLines, hasTrailingNewline, lineEnding } = await readFileLines(resolvedPath);
    const locate = locateModifyRange(fileLines, startLine, endLine, replaceLines, pretext, endtext);
    if (!locate.ok) {
      return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: locate.error }, locate.message);
    }
    const { actualStart, actualEnd, locateMessage } = locate;

    const newLines = [...fileLines.slice(0, actualStart - 1), ...replaceLines, ...fileLines.slice(actualEnd)];
    const description = '修改行 ' + actualStart + '-' + actualEnd + '（' + replaceLines.length + ' 行）';

    if (!force) {
      const newContent = newLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const checkResult = checkSyntax(resolvedPath, newContent);
      if (!checkResult.ok) {
        const replaceRange = { start: actualStart, end: actualStart + replaceLines.length - 1 };
        const errMsg = formatSyntaxErrors(checkResult, {
          oldLines: fileLines, newLines, replaceRange,
          precheck: precheckReplacement(resolvedPath, replaceLines),
        });
        return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: errMsg }, errMsg);
      }
    }

    const record = await undoStack.executeWrite(
      resolvedPath, 'modify', description, fileLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = '✅ [MODIFY] ' + description + '\n📄 文件：' + resolvedPath + '\n📐 行数：' + fileLines.length + ' → ' + newLines.length + '\n📝 diff 已持久化到：' + record.diffFilePath + '\n';
    if (locateMessage) msg += '🔍 ' + locateMessage + '\n';
    if (record.diff) msg += '\n--- diff ---\n' + record.diff;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'modify', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});

// ============================================================
// 6. undo_patch
// ============================================================
export const undoPatch = tool({
  description: `撤销最近一次文件修改操作。从撤销栈中恢复文件到修改前的状态。
  撤销栈持久化在 <workdir>/.seek-agent/history/ 目录下，可跨会话使用。`,
  inputSchema: z.object({}),
  execute: async () => {
    const record = await undoStack.undo();
    if (!record) return new ToolOutput({ type: 'patch', action: 'undo', description: '撤销栈为空' }, '📭 没有可撤销的操作。');

    let msg = `↩️ 已撤销操作：\n`;
    msg += `  ■ 类型：[${record.meta.type.toUpperCase()}] ${record.meta.description}\n`;
    msg += `  📄 文件：${record.meta.filePath}\n`;
    msg += `  📝 diff 来源：${record.diffFilePath}\n`;
    msg += `\n--- 恢复完成 ---\n`;
    msg += `  已从 ${record.newContent.length} 字符恢复到 ${record.oldContent.length} 字符`;

    return new ToolOutput({ type: 'patch', action: 'undo', description: record.meta.description, filePath: record.meta.filePath }, msg);
  },
});

// ============================================================
// 7. history_patch
// ============================================================
export const historyPatch = tool({
  description: `查看文件操作历史记录。不传参数时列出所有历史记录，传入文件路径可筛选特定文件的历史。`,
  inputSchema: z.object({
    filePath: z.string().optional().describe('（可选）筛选特定文件的历史记录'),
  }),
  execute: async ({ filePath }) => {
    const allEntries = filePath ? undoStack.getByFile(resolvePath(filePath)) : undoStack.getAll();
    const diskCount = await undoStack.diskSize();
    if (allEntries.length === 0) {
      const msg = filePath ? `📭 文件 ${resolvePath(filePath)} 没有操作记录。` : '📭 没有文件操作记录。';
      return new ToolOutput({ type: 'patch', action: 'history', description: msg }, msg);
    }
    const lines: string[] = [`📋 文件操作历史（内存 ${allEntries.length} 条，磁盘共 ${diskCount} 条）：`, ''];
    for (let i = 0; i < allEntries.length; i++) {
      const r = allEntries[i];
      const time = new Date(r.meta.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
      lines.push(`  ${i + 1}. [${time}] [${r.meta.type.toUpperCase()}] ${r.meta.description}`);
      lines.push(`      📄 ${r.meta.filePath}  📝 ${r.diffFilePath}`);
      if (r.diff) {
        const dl = r.diff.split('\n').slice(0, 5);
        dl.forEach(d => lines.push(`      ${d}`));
        if (r.diff.split('\n').length > 5) lines.push(`      ... 其余省略`);
      }
      lines.push('');
    }
    lines.push('💡 执行 undo_patch() 撤销最近一次操作');
    return new ToolOutput({ type: 'patch', action: 'history', description: `共有 ${allEntries.length} 条操作记录` }, lines.join('\n'));
  },
});

// ============================================================
// 子 Agent 独立暂存区支持
// ============================================================
export async function applyPatchesToFile(
  filePath: string,
  patches: Array<{ type: string; params: Record<string, any> }>
): Promise<string[]> {
  const { lines: fileLines, hasTrailingNewline, lineEnding } = await readFileLines(filePath);
  const results: string[] = [];

  const sorted = [...patches].sort((a, b) => {
    const getBase = (p: typeof a) => {
      switch (p.type) {
        case 'modify': return (p.params as any).startLine ?? Infinity;
        case 'del': return Math.min(...((p.params as any).lineIndex as [number, number][]).map(([s]) => s));
        case 'add': { const li = (p.params as any).lineIndex as number; return li === -1 ? Infinity : li; }
        default: return Infinity;
      }
    };
    return (getBase(b) as number) - (getBase(a) as number);
  });

  let currentLines = [...fileLines];
  const originalTotal = fileLines.length;

  for (const patch of sorted) {
    try {
      switch (patch.type) {
        case 'add': {
          const { lineIndex, Lines } = patch.params as { lineIndex: number; Lines: string[] };
          const idx = lineIndex === -1 ? currentLines.length : lineIndex;
          currentLines = [...currentLines.slice(0, idx), ...Lines, ...currentLines.slice(idx)];
          const addDesc = lineIndex === -1 ? '文件末尾' : lineIndex === 0 ? '文件开头' : `第 ${lineIndex} 行后`;
          results.push(`  [ADD] 在${addDesc}插入 ${Lines.length} 行`);
          break;
        }
        case 'del': {
          const { lineIndex } = patch.params as { lineIndex: [number, number][] };
          const merged = [...lineIndex].sort((a, b) => a[0] - b[0]);
          const combined: [number, number][] = [];
          for (const [s, e] of merged) {
            if (combined.length === 0 || s > combined[combined.length - 1][1] + 1) combined.push([s, e]);
            else combined[combined.length - 1][1] = Math.max(combined[combined.length - 1][1], e);
          }
          const zeroBased = combined.map(([s, e]) => [s - 1, e - 1] as [number, number]).sort((a, b) => b[0] - a[0]);
          let deleted = 0;
          for (const [s, e] of zeroBased) { currentLines.splice(s, e - s + 1); deleted += e - s + 1; }
          results.push(`  [DEL] 删除 ${deleted} 行`);
          break;
        }
        case 'modify': {
          const { startLine, endLine, replaceLines } = patch.params as { startLine: number; endLine: number; replaceLines: string[]; };
          currentLines = [...currentLines.slice(0, startLine - 1), ...replaceLines, ...currentLines.slice(endLine)];
          results.push(`  [MODIFY] 替换行 ${startLine}-${endLine}（${replaceLines.length} 行）`);
          break;
        }
      }
    } catch (err: any) {
      results.push(`  ❌ 应用失败 [${patch.type}]: ${err.message}`);
    }
  }

  const content = currentLines.join(lineEnding) + (hasTrailingNewline && currentLines.length > 0 ? lineEnding : '');
  await fs.writeFile(filePath, content, 'utf8');
  results.push(`  （行数: ${originalTotal} → ${currentLines.length} 行）`);
  results.push(`  💾 已写入文件`);
  return results;
}

// ── 导出 UndoStack 以供外部使用 ──
export { UndoStack } from './patch-undo.js';











































