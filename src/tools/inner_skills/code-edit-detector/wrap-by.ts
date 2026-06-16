import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../workdir.js';

/**
 * 检测一行的前导空白（缩进）
 */
function getLeadingWhitespace(line: string): string {
  const m = line.match(/^(\s*)/);
  return m ? m[1] : '';
}

/**
 * 从文件已有的缩进风格推断一级缩进单位
 * - 如果行首包含制表符，用制表符
 * - 否则尝试从附近行的缩进量推断，兜底用 2 空格
 */
function detectIndentUnit(lines: string[], startLine: number, endLine: number): string {
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
  范围内每行自动增加一级缩进。`,
  inputSchema: z.object({
    filePath: z.string().describe('目标文件的路径（绝对路径或相对当前工作目录的路径）'),
    startLine: z.number().describe('起始行号（从 1 开始，包含该行）'),
    endLine: z.number().describe('结束行号（从 1 开始，包含该行）'),
    wrapString: z.string().describe('在第一个大括号前添加的内容，如 "if (x > 0)"、"try"、"for (const item of list)"'),
  }),
  execute: async ({ filePath, startLine, endLine, wrapString }): Promise<string> => {
    try {
      const resolvedPath = resolvePath(filePath);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      // 验证行号
      if (startLine < 1 || startLine > totalLines) {
        return `起始行号 ${startLine} 超出文件范围（1-${totalLines}）。`;
      }
      if (endLine < 1 || endLine > totalLines) {
        return `结束行号 ${endLine} 超出文件范围（1-${totalLines}）。`;
      }
      if (startLine > endLine) {
        return `起始行号 ${startLine} 不能大于结束行号 ${endLine}。`;
      }

      // 基准缩进 = 起始行的前导空白
      const baseIndent = getLeadingWhitespace(lines[startLine - 1]);
      // 一级缩进单位
      const unit = detectIndentUnit(lines, startLine, endLine);
      const innerIndent = baseIndent + unit;

      // 构建新内容
      const newLines: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1; // 1-based

        if (lineNum === startLine) {
          // 包裹头：{baseIndent}{wrapString} {
          newLines.push(wrapString
            ? `${baseIndent}${wrapString} {`
            : `${baseIndent}{`);
        }

        if (lineNum >= startLine && lineNum <= endLine) {
          // 范围内的行增加一级缩进
          newLines.push(innerIndent + lines[i]);
        }

        if (lineNum === endLine) {
          // 包裹尾：{baseIndent}}
          newLines.push(`${baseIndent}}`);
        }

        // 范围外的行已在上面通过条件跳过，这里补上
        if (lineNum < startLine || lineNum > endLine) {
          newLines.push(lines[i]);
        }
      }

      await fs.writeFile(resolvedPath, newLines.join('\n'), 'utf-8');

      const rangeDesc = startLine === endLine
        ? `第 ${startLine} 行`
        : `第 ${startLine}-${endLine} 行`;

      const wrapDesc = wrapString
        ? `${wrapString} { ... }`
        : `{ ... }`;

      return `已用 ${wrapDesc} 包裹 ${rangeDesc}。
${baseIndent}${wrapString ? wrapString + ' {' : '{'}
${innerIndent}... ${endLine - startLine + 1} 行 ...
${baseIndent}}}`;
    } catch (error) {
      return `包裹失败: ${(error as Error).message}`;
    }
  },
});
