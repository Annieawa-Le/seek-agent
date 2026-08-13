import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../../workdir.js';
import { ToolOutput } from '../../../tool-output.js';
import { undoStack } from '../../../patch-undo.js';
import { checkSyntax, formatSyntaxErrors } from '../../../syntax-validator.js';

/**
 * 检测一行的前导空白（缩进）
 */
export function getLeadingWhitespace(line: string): string {
  const m = line.match(/^(\s*)/);
  return m ? m[1] : '';
}

/**
 * 从文件已有的缩进风格推断一级缩进单位
 * - 如果行首包含制表符，用制表符
 * - 否则尝试从附近行的缩进量推断，兜底用 2 空格
 */
export function detectIndentUnit(lines: string[], startLine: number, endLine: number): string {
  // 先检查范围内的行是否用 tab
  for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
    const ws = getLeadingWhitespace(lines[i]);
    if (ws.startsWith('\t')) return '\t';
  }

  // 检查范围外附近的行
  const checkRange = [
    Math.max(0, startLine - 2),
    Math.min(lines.length - 1, endLine),
  ];
  for (let i = checkRange[0]; i <= checkRange[1]; i++) {
    const ws = getLeadingWhitespace(lines[i]);
    if (ws.startsWith('\t')) return '\t';
  }

  // 尝试从现有缩进量推断空格数（取出现最多的差值）
  const indentSizes: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = getLeadingWhitespace(lines[i - 1]).length;
    const curr = getLeadingWhitespace(lines[i]).length;
    const diff = curr - prev;
    if (diff > 0 && diff <= 8) indentSizes.push(diff);
  }

  if (indentSizes.length > 0) {
    // 取最常见的差值
    const freq = new Map<number, number>();
    for (const d of indentSizes) freq.set(d, (freq.get(d) || 0) + 1);
    let best = 2;
    let bestCount = 0;
    for (const [size, count] of freq) {
      if (count > bestCount) { best = size; bestCount = count; }
    }
    return ' '.repeat(best);
  }

  return '  '; // 兜底 2 空格
}

export const wrapBy = tool({
  description: `用大括号包裹指定行范围，并在第一个大括号前插入指定字符串。自动处理缩进。
  例如将 2-4 行用 "if (x > 0)" 包裹，会生成：
    if (x > 0) {
      ...原有第2行...
      ...原有第3行...
      ...原有第4行...
    }
  范围内每行自动增加一级缩进。
  与 patch 工具一致：语法检查 + diff 持久化，可用 undo_patch() 撤销。`,
  inputSchema: z.object({
    filePath: z.string().describe('目标文件的路径（绝对路径或相对当前工作目录的路径）'),
    startLine: z.number().describe('起始行号（从 1 开始，包含该行）'),
    endLine: z.number().describe('结束行号（从 1 开始，包含该行）'),
    wrapString: z.string().describe('在第一个大括号前添加的内容，如 "if (x > 0)"、"try"、"for (const item of list)"'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, startLine, endLine, wrapString, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: '文件路径为空' }, '❌ 错误：文件路径为空');

    const resolvedPath = resolvePath(filePath);
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, 'utf-8');
    } catch (error: any) {
      const errMsg = `读取文件失败: ${error?.message || error}`;
      return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: errMsg }, errMsg);
    }

    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const hasTrailingNewline = content.endsWith('\n') || content.endsWith('\r\n');
    const rawLines = content.split(/\r?\n/);
    // 末尾换行产生的空元素去掉，避免写盘多出空行（与 readFileLines 行为一致）
    const lines = hasTrailingNewline && rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
    const totalLines = lines.length;

    if (startLine < 1 || startLine > totalLines) {
      return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: `起始行号 ${startLine} 超出文件范围（1-${totalLines}）。` }, `❌ 起始行号 ${startLine} 超出文件范围（1-${totalLines}）。`);
    }
    if (endLine < 1 || endLine > totalLines) {
      return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: `结束行号 ${endLine} 超出文件范围（1-${totalLines}）。` }, `❌ 结束行号 ${endLine} 超出文件范围（1-${totalLines}）。`);
    }
    if (startLine > endLine) {
      return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: `起始行号 ${startLine} 不能大于结束行号 ${endLine}。` }, `❌ 起始行号 ${startLine} 不能大于结束行号 ${endLine}。`);
    }

    // 基准缩进 = 起始行的前导空白
    const baseIndent = getLeadingWhitespace(lines[startLine - 1]);
    // 一级缩进单位
    const unit = detectIndentUnit(lines, startLine, endLine);
    const innerIndent = baseIndent + unit;

    // 构建新内容
    const oldLines = lines;
    const newLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1; // 1-based
      if (lineNum === startLine) {
        newLines.push(wrapString ? `${baseIndent}${wrapString} {` : `${baseIndent}{`);
      }
      if (lineNum >= startLine && lineNum <= endLine) {
        // 新缩进 = 新基准(innerIndent) + 原行相对基准行的额外缩进（保留原风格，避免重复累加）
        const origWs = getLeadingWhitespace(lines[i]);
        const relWs = origWs.slice(baseIndent.length);
        newLines.push(innerIndent + relWs + lines[i].trimStart());
      }
      if (lineNum === endLine) {
        newLines.push(`${baseIndent}}`);
      }
      if (lineNum < startLine || lineNum > endLine) {
        newLines.push(lines[i]);
      }
    }

    // ── 语法检查（非 force） ──
    if (!force) {
      const newContent = newLines.join(lineEnding) + (hasTrailingNewline ? lineEnding : '');
      const checkResult = checkSyntax(resolvedPath, newContent);
      if (!checkResult.ok) {
        const errMsg = formatSyntaxErrors(checkResult, { oldLines, newLines });
        return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: errMsg }, errMsg);
      }
    }

    // ── 写盘 + diff 持久化（可撤销） ──
    const rangeDesc = startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`;
    const wrapDesc = wrapString ? `${wrapString} { ... }` : `{ ... }`;
    const description = `用 ${wrapDesc} 包裹 ${rangeDesc}`;

    const record = await undoStack.executeWrite(
      resolvedPath, 'modify', description, oldLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = `✅ [WRAP] ${description}\n📄 文件：${resolvedPath}\n📐 行数：${oldLines.length} → ${newLines.length}\n📝 diff 已持久化到：${record.diffFilePath}\n`;
    msg += `\n${baseIndent}${wrapString ? wrapString + ' {' : '{'}\n${innerIndent}... ${endLine - startLine + 1} 行 ...\n${baseIndent}}}\n`;
    if (record.diff) msg += '\n--- diff ---\n' + record.diff;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'modify', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});




