/**
 * file-manipulation.ts — 文件操作工具集
 *
 * ── 设计变更 ──
 * 取消暂存区模式。所有 patch 工具以 diff 作为操作核心载体：
 *   旧内容 + 新内容 → 生成 diff → 写入 .diff 历史文件（持久化到磁盘）
 *   → apply diff 到目标文件 → 返回 diff 展示
 *
 * 工具清单：
 *   create_file     — 创建新文件（独占写入）
 *   replace_file    — 替换文件内容（diff 化 + 持久化）
 *   add_patch       — 在指定行前插入内容（diff 化 + 持久化）
 *   del_patch       — 删除指定行（diff 化 + 持久化 + 智能定位）
 *   modify_patch    — 替换指定行内容（diff 化 + 持久化 + 智能定位）
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
import { smartLocate } from './patch-locator.js';
import { checkSyntax, formatSyntaxErrors } from './syntax-validator.js';

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
  force 为 true 时跳过语法检查。注意：此工具直接执行，不会进入暂存区。`,
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

      // 语法检查
      if (!force) {
        const checkResult = checkSyntax(targetPath, fileContent);
        if (!checkResult.ok) {
          const errMsg = formatSyntaxErrors(checkResult);
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
  description: `直接在文件中指定行前插入内容。以 diff 为核心载体：
  生成 diff → 持久化到磁盘历史 → 写入目标文件 → 展示 diff。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    lineIndex: z.number().int().describe('插入的行号（-1 表示追加到末尾，行号从 1 开始）'),
    Lines: z.array(z.string()).describe('要插入的内容行列表'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, lineIndex, Lines, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'add', description: '', error: '文件路径不能为空' }, '❌ 错误：文件路径不能为空');
    if (!Lines?.length) return new ToolOutput({ type: 'patch', action: 'add', description: '', error: '写入内容不能为空' }, '❌ 错误：写入内容不能为空');

    const resolvedPath = resolvePath(filePath);
    const { lines: fileLines, hasTrailingNewline, lineEnding } = await readFileLines(resolvedPath);

    const insertIndex = lineIndex === -1 ? fileLines.length : lineIndex - 1;
    if (lineIndex !== -1 && (lineIndex < 1 || lineIndex > fileLines.length + 1)) {
      return new ToolOutput({ type: 'patch', action: 'add', description: '', error: `行号 ${lineIndex} 超出范围` },
        `❌ 错误：行号 ${lineIndex} 超出范围`);
    }

    const newLines = [...fileLines.slice(0, insertIndex), ...Lines, ...fileLines.slice(insertIndex)];
    const description = lineIndex === -1 ? `在末尾追加 ${Lines.length} 行` : `在第 ${lineIndex} 行前插入 ${Lines.length} 行`;

      // 语法检查
      if (!force) {
        const newContent = newLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
        const checkResult = checkSyntax(resolvedPath, newContent);
        if (!checkResult.ok) {
          const errMsg = formatSyntaxErrors(checkResult);
          return new ToolOutput({ type: 'patch', action: 'add', description: '', error: errMsg }, errMsg);
        }
      }
    const record = await undoStack.executeWrite(
      resolvedPath, 'add', description, fileLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = `✅ [ADD] ${description}\n📄 文件：${resolvedPath}\n📐 行数：${fileLines.length} → ${newLines.length}\n`;
    msg += `📝 diff 已持久化到：${record.diffFilePath}\n`;
    if (record.diff) msg += `\n--- diff ---\n${record.diff}`;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'add', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});

// ============================================================
// 4. del_patch
// ============================================================
export const delPatch = tool({
  description: `直接从文件中删除指定行。以 diff 为核心载体。系统自动修正行号偏移。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    lineIndex: z.array(z.array(z.number().int())).describe('要删除的行范围，格式 [[start,end], ...]'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, lineIndex, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: '文件路径不能为空' }, '❌ 错误：文件路径不能为空');
    if (!lineIndex?.length) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: '删除范围不能为空' }, '❌ 错误：删除范围不能为空');
    for (const range of lineIndex) {
      if (!Array.isArray(range) || range.length !== 2) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: `格式错误：${JSON.stringify(range)}` }, '❌ 错误：删除范围格式不正确');
      if (!Number.isInteger(range[0]) || !Number.isInteger(range[1])) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: `行号需为整数：${range[0]}, ${range[1]}` }, '❌ 错误：行号必须是整数');
      if (range[0] < 1 || range[1] < 1) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: `行号需 >= 1：${range[0]}, ${range[1]}` }, '❌ 错误：行号必须 >= 1');
      if (range[0] > range[1]) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: `起始 ${range[0]} > 结束 ${range[1]}` }, '❌ 错误：起始行不能大于结束行');
    }

    const resolvedPath = resolvePath(filePath);
    const { lines: fileLines, hasTrailingNewline, lineEnding } = await readFileLines(resolvedPath);

    const correctedRanges: [number, number][] = [];
    const locateMessages: string[] = [];
    for (const [anchorStart, anchorEnd] of lineIndex) {
      const r = await smartLocate(resolvedPath, { anchorStart, anchorEnd, fileLines, newLines: [], operation: 'del', radius: 10 });
      if (r.matched && r.message) locateMessages.push(r.message);
      correctedRanges.push([r.startLine, r.endLine]);
    }
    const sorted = [...correctedRanges].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of sorted) {
      if (merged.length === 0 || s > merged[merged.length - 1][1] + 1) merged.push([s, e]);
      else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
    for (const [s, e] of merged) {
      if (s < 1 || e > fileLines.length) return new ToolOutput({ type: 'patch', action: 'del', description: '', error: `范围 [${s}, ${e}] 超出文件范围` }, `❌ 错误：删除范围 [${s}, ${e}] 超出文件范围`);
    }

    const zeroBased = merged.map(([s, e]) => [s - 1, e - 1] as [number, number]).sort((a, b) => b[0] - a[0]);
    let newLines = [...fileLines];
    let deletedCount = 0;
    for (const [s, e] of zeroBased) { newLines.splice(s, e - s + 1); deletedCount += e - s + 1; }

    const deletedInfo = merged.map(([s, e]) => s === e ? `行 ${s}` : `行 ${s}-${e}`).join('、');
    const description = `删除 ${deletedCount} 行（${deletedInfo}）`;

      // 语法检查
      if (!force) {
        const newContent = newLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
        const checkResult = checkSyntax(resolvedPath, newContent);
        if (!checkResult.ok) {
          const errMsg = formatSyntaxErrors(checkResult);
          return new ToolOutput({ type: 'patch', action: 'del', description: '', error: errMsg }, errMsg);
        }
      }
    const record = await undoStack.executeWrite(
      resolvedPath, 'del', description, fileLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = `✅ [DEL] ${description}\n📄 文件：${resolvedPath}\n📐 行数：${fileLines.length} → ${newLines.length}\n📝 diff 已持久化到：${record.diffFilePath}\n`;
    if (locateMessages.length > 0) msg += `🔍 ${locateMessages.join('；')}\n`;
    if (record.diff) msg += `\n--- diff ---\n${record.diff}`;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'del', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});

// ============================================================
// 5. modify_patch
// ============================================================
export const modifyPatch = tool({
  description: `直接替换文件中指定行的内容。以 diff 为核心载体。
  系统自动从 replaceLines 提取特征定位最佳匹配位置，修正行号偏移。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    startLine: z.number().int().describe('要替换的起始行号（从 1 开始）'),
    endLine: z.number().int().describe('要替换的结束行号（从 1 开始，包含该行）'),
    replaceLines: z.array(z.string()).describe('替换后的新内容行列表'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, startLine, endLine, replaceLines, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: '文件路径为空' }, '❌ 错误：文件路径为空');
    if (!Array.isArray(replaceLines)) return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: 'replaceLines 必须是字符串数组' }, '❌ 错误：replaceLines 必须是字符串数组');

    const resolvedPath = resolvePath(filePath);
    const { lines: fileLines, hasTrailingNewline, lineEnding } = await readFileLines(resolvedPath);
    if (startLine < 1 || endLine > fileLines.length) return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: `行号超出范围` }, `❌ 错误：行号超出文件范围`);

    let actualStart = startLine, actualEnd = endLine;
    const locateResult = await smartLocate(resolvedPath, { anchorStart: startLine, anchorEnd: endLine, fileLines, newLines: replaceLines, operation: 'modify', radius: 10 });
    if (locateResult.matched) { actualStart = locateResult.startLine; actualEnd = locateResult.endLine; }
    if (actualStart < 1) actualStart = 1;
    if (actualEnd > fileLines.length) actualEnd = fileLines.length;

    const newLines = [...fileLines.slice(0, actualStart - 1), ...replaceLines, ...fileLines.slice(actualEnd)];
    const description = `修改行 ${actualStart}-${actualEnd}（${replaceLines.length} 行）`;

      // 语法检查
      if (!force) {
        const newContent = newLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
        const checkResult = checkSyntax(resolvedPath, newContent);
        if (!checkResult.ok) {
          const errMsg = formatSyntaxErrors(checkResult);
          return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: errMsg }, errMsg);
        }
      }
    const record = await undoStack.executeWrite(
      resolvedPath, 'modify', description, fileLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = `✅ [MODIFY] ${description}\n📄 文件：${resolvedPath}\n📐 行数：${fileLines.length} → ${newLines.length}\n📝 diff 已持久化到：${record.diffFilePath}\n`;
    if (locateResult.matched && locateResult.message) msg += `🔍 ${locateResult.message}\n`;
    if (record.diff) msg += `\n--- diff ---\n${record.diff}`;
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
          const idx = lineIndex === -1 ? currentLines.length : lineIndex - 1;
          currentLines = [...currentLines.slice(0, idx), ...Lines, ...currentLines.slice(idx)];
          results.push(`  [ADD] 在第 ${lineIndex} 行前插入 ${Lines.length} 行`);
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










