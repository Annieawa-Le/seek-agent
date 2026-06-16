import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../workdir.js';

/**
 * 在整个文件内容中，从指定字符位置开始查找匹配的闭括号 '}'。
 * 考虑嵌套花括号，返回闭括号的字符索引（含该字符）。
 * 若未找到匹配则返回 -1。
 */
function findMatchingCloseBrace(content: string, openBracePos: number): number {
  let depth = 1;
  let pos = openBracePos + 1;
  while (pos < content.length && depth > 0) {
    const ch = content[pos];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth > 0) pos++;
  }
  return depth === 0 ? pos : -1;
}

/**
 * 从指定行内容中提取第一个非自闭合的 HTML/XML 开标签名。
 * 返回 null 表示该行没有有效的开标签。
 */
function extractOpeningTag(line: string): string | null {
  const tagRegex = /<(\w+)((?:\s[^>]*)?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(line)) !== null) {
    const fullTag = match[0];
    const tagName = match[1];
    // 跳过闭合标签 </xxx>
    if (fullTag.startsWith('</')) continue;
    // 跳过自闭合标签 <xxx ... />
    if (fullTag.trimEnd().endsWith('/')) continue;
    // 跳过注释 <!-- ... -->
    if (fullTag.startsWith('<!--')) continue;
    // 跳过 DOCTYPE
    if (tagName.toUpperCase() === '!DOCTYPE') continue;
    return tagName;
  }
  return null;
}

/**
 * 判断某行是否包含自闭合标签（用于前置检查）
 */
function isSelfClosingTag(line: string): boolean {
  return /<(\w+)(?:\s[^>]*)?\/\s*>/.test(line);
}

/**
 * 扫描文件内容，找到与开标签匹配的闭合标签行号。
 * 正确处理同类型标签的嵌套。
 */
function findMatchingCloseTag(
  lines: string[],
  tagName: string,
  openLine: number, // 1-based
): number {
  const openRegex = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'i');
  const closeRegex = new RegExp(`</${tagName}\\s*>`, 'i');

  let depth = 1;
  for (let i = openLine; i < lines.length; i++) {
    const line = lines[i];
    if (i === openLine) {
      // 跳过开标签所在行自身
      continue;
    }
    // 统计本行中的开/闭标签
    const opens = [...line.matchAll(openRegex)];
    const closes = [...line.matchAll(closeRegex)];

    depth += opens.length;
    depth -= closes.length;

    if (depth <= 0) {
      return i + 1; // 转回 1-based 行号
    }
  }
  return -1;
}

export const findMatchingBrace = tool({
  description: `给定某行，若该行存在开大括号'{'或HTML/XML开标签，返回对应的闭括号'}'或反标签的行号。支持嵌套匹配。`,
  inputSchema: z.object({
    filePath: z.string().describe('目标文件的路径（绝对路径或相对当前工作目录的路径）'),
    lineNumber: z.number().describe('要检测的行号（从1开始）。该行应包含"{"或HTML/XML开标签'),
  }),
  execute: async ({ filePath, lineNumber }): Promise<string> => {
    try {
      const resolvedPath = resolvePath(filePath);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      if (lineNumber < 1 || lineNumber > totalLines) {
        return `行号 ${lineNumber} 超出文件范围。文件共 ${totalLines} 行（1-${totalLines}）。`;
      }

      const targetLine = lines[lineNumber - 1];

      // ── 情况 1: 查找大括号匹配 ──
      const braceIdx = targetLine.indexOf('{');
      if (braceIdx !== -1) {
        // 计算 '{' 在完整内容中的字符偏移
        let charPos = 0;
        for (let i = 0; i < lineNumber - 1; i++) {
          charPos += lines[i].length + 1; // +1 换行符
        }
        charPos += braceIdx;

        const closePos = findMatchingCloseBrace(content, charPos);
        if (closePos === -1) {
          return `从第 ${lineNumber} 行开始存在不匹配的开大括号 '{'，未找到对应的闭括号 '}'。`;
        }

        const closeLine = content.substring(0, closePos).split('\n').length;
        const closeContent = lines[closeLine - 1].trim();

        return JSON.stringify({
          type: 'brace',
          openBraceLine: lineNumber,
          closeBraceLine: closeLine,
          closeLineContent: closeContent,
        });
      }

      // ── 情况 2: 查找 HTML/XML 标签匹配 ──
      // 先排除自闭合标签
      if (isSelfClosingTag(targetLine)) {
        return `第 ${lineNumber} 行是自闭合标签，无需匹配闭合标签。`;
      }

      const tagName = extractOpeningTag(targetLine);
      if (tagName) {
        const closeLine = findMatchingCloseTag(lines, tagName, lineNumber);
        if (closeLine === -1) {
          return `从第 ${lineNumber} 行开始的开标签 <${tagName}> 未找到对应的闭合标签 </${tagName}>。`;
        }
        const closeContent = lines[closeLine - 1].trim();

        return JSON.stringify({
          type: 'tag',
          tagName,
          openLine: lineNumber,
          closeLine,
          closeLineContent: closeContent,
        });
      }

      return `第 ${lineNumber} 行未发现开大括号 '{' 或 HTML/XML 开标签。行内容: ${targetLine.trim()}`;
    } catch (error) {
      return `查找失败: ${(error as Error).message}`;
    }
  },
});
