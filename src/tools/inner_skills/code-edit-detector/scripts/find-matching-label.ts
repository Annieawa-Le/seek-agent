import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../../workdir.js';

/** HTML 标准自闭合标签（无需闭合标签） */
const SELF_CLOSING_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

interface TagInfo {
  tagName: string;
  isClose: boolean;
  line: number; // 1-based
  content: string;
}

/** 从一行中提取所有非自闭合标签（开/闭），跳过注释与标准自闭合标签 */
function extractTags(line: string, lineNo: number): TagInfo[] {
  const tags: TagInfo[] = [];
  const tagRegex = /<\/?([A-Za-z][A-Za-z0-9._-]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(line)) !== null) {
    const full = m[0];
    const tagName = m[1];
    if (full.startsWith('<!--')) continue;
    if (SELF_CLOSING_TAGS.has(tagName.toLowerCase())) continue;
    if (full.trimEnd().endsWith('/>')) continue; // JSX/XML 自闭合
    tags.push({
      tagName,
      isClose: full.startsWith('</'),
      line: lineNo,
      content: line.trim(),
    });
  }
  return tags;
}

/** 向后扫描：从 openLine 的下一行起，找与 tagName 配对的闭合标签行（1-based，-1 未找到） */
function findMatchingCloseTag(
  lines: string[],
  tagName: string,
  openLine: number, // 1-based
): number {
  const openRegex = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
  const closeRegex = new RegExp(`</${tagName}\\s*>`, 'gi');

  let depth = 0;
  for (let i = openLine - 1; i < lines.length; i++) {
    const line = lines[i];
    const opens = [...line.matchAll(openRegex)];
    const closes = [...line.matchAll(closeRegex)];
    depth += opens.length - closes.length;
    if (depth <= 0 && (i > openLine - 1 || opens.length > 0)) return i + 1;
  }
  return -1;
  return -1;
}

/** 向前扫描：从 closeLine 的上一行起，找与 tagName 配对的开标签行（1-based，-1 未找到） */
function findMatchingOpenTag(
  lines: string[],
  tagName: string,
  closeLine: number, // 1-based
): number {
  const openRegex = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
  const closeRegex = new RegExp(`</${tagName}\\s*>`, 'gi');

  let depth = 0;
  for (let i = closeLine - 2; i >= 0; i--) {
    const line = lines[i];
    const opens = [...line.matchAll(openRegex)];
    const closes = [...line.matchAll(closeRegex)];
    depth += closes.length - opens.length;
    if (depth < 0) return i + 1;
  }
  return -1;
}

export const findMatchingLabel = tool({
  description: `查找 HTML/JSX/XML 标签的配对行号：给定某行，若该行是开标签则返回匹配的闭合标签行号；若该行是闭合标签则反向找到对应的开标签行号。支持嵌套匹配。
  可指定 tagName 精确指定标签（一行含多个标签时）。与 find_matching_brace（花括号优先）互补，本工具只处理标签。`,
  inputSchema: z.object({
    filePath: z.string().describe('目标文件的路径（绝对路径或相对当前工作目录的路径）'),
    lineNumber: z.number().describe('要检测的行号（从 1 开始）。该行应包含 HTML/JSX 开标签或闭合标签'),
    tagName: z.string().optional().describe('可选：指定标签名（如 div、MyComponent）。不指定时自动检测行内第一个非自闭合标签'),
  }),
  execute: async ({ filePath, lineNumber, tagName }): Promise<string> => {
    try {
      const resolvedPath = resolvePath(filePath);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      if (lineNumber < 1 || lineNumber > totalLines) {
        return `行号 ${lineNumber} 超出文件范围。文件共 ${totalLines} 行（1-${totalLines}）。`;
      }

      const targetLine = lines[lineNumber - 1];
      let tags = extractTags(targetLine, lineNumber);
      if (tagName) {
        tags = tags.filter(t => t.tagName === tagName);
      }
      if (tags.length === 0) {
        const hint = tagName ? `标签 <${tagName}>` : 'HTML/JSX 标签';
        return `第 ${lineNumber} 行未发现${hint}（非自闭合）。行内容: ${targetLine.trim()}`;
      }

      const tag = tags[0];

      if (tag.isClose) {
        // 闭合标签 → 反向找开标签
        const openLine = findMatchingOpenTag(lines, tag.tagName, lineNumber);
        if (openLine === -1) {
          return `第 ${lineNumber} 行的闭合标签 </${tag.tagName}> 未找到对应的开标签。`;
        }
        return JSON.stringify({
          type: 'close-to-open',
          tagName: tag.tagName,
          closeLine: lineNumber,
          openLine,
          closeLineContent: lines[lineNumber - 1].trim(),
          openLineContent: lines[openLine - 1].trim(),
        });
      }

      // 开标签 → 向后找闭合标签
      const closeLine = findMatchingCloseTag(lines, tag.tagName, lineNumber);
      if (closeLine === -1) {
        return `从第 ${lineNumber} 行开始的开标签 <${tag.tagName}> 未找到对应的闭合标签 </${tag.tagName}>。`;
      }
      return JSON.stringify({
        type: 'open-to-close',
        tagName: tag.tagName,
        openLine: lineNumber,
        closeLine,
        openLineContent: lines[lineNumber - 1].trim(),
        closeLineContent: lines[closeLine - 1].trim(),
      });
    } catch (error) {
      return `查找失败: ${(error as Error).message}`;
    }
  },
});





