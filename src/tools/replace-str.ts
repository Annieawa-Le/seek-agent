/**
 * replace-str.ts — 快速字符串替换工具（dsh str_replace 标准语义）
 *
 * 字面量（非正则）查找替换，对齐 dsh edit/str_replace 的标准：
 *   - 默认大小写敏感的字面量精确匹配
 *   - 默认要求唯一匹配：search 出现多次时拒绝执行（除非 replaceAll=true 全量替换）
 * 与 patch 工具一致：语法检查（可 force 跳过）+ diff 持久化（undo_patch 可撤销）。
 */

import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../workdir.js';
import { ToolOutput } from './tool-output';
import { undoStack } from './patch-undo.js';
import { checkSyntax, formatSyntaxErrors } from './syntax-validator.js';

// ============================================================
// 纯替换逻辑（导出便于测试）
// ============================================================

export interface ReplaceOptions {
  /** 大小写敏感（默认 true，字面量精确匹配） */
  caseSensitive?: boolean;
  /** 整个单词匹配：匹配边界前后不能是字母/数字/下划线（默认 false） */
  wholeWord?: boolean;
  /** 全部替换（默认 false；false 时要求 search 唯一匹配） */
  replaceAll?: boolean;
}

export interface TextMatch {
  /** 匹配段起始偏移（相对原内容，0-based） */
  start: number;
  /** 匹配段结束偏移（不含，0-based） */
  end: number;
  /** 匹配所在行（1-based） */
  line: number;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** 整词边界检查：匹配段前后不能是单词字符 */
function isWordBoundary(content: string, start: number, end: number): boolean {
  const before = start > 0 ? content[start - 1] : undefined;
  const after = end < content.length ? content[end] : undefined;
  return !isWordChar(before) && !isWordChar(after);
}

/** 按匹配起始偏移计算各匹配所在行号（1-based；支持跨行 search） */
function lineNumbersAt(content: string, offsets: number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === '\n') line += 1;
      cursor += 1;
    }
    return line;
  });
}

/** 在 content 中查找所有非重叠匹配位置（普通字符串，非正则） */
export function findMatches(
  content: string,
  search: string,
  options: ReplaceOptions = {},
): TextMatch[] {
  if (!search) return [];
  const caseSensitive = options.caseSensitive ?? true;
  const wholeWord = options.wholeWord ?? false;
  const haystack = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? search : search.toLowerCase();

  const offsets: number[] = [];
  let offset = 0;
  while (offset < content.length) {
    const idx = haystack.indexOf(needle, offset);
    if (idx < 0) break;
    if (!wholeWord || isWordBoundary(content, idx, idx + search.length)) {
      offsets.push(idx);
      offset = idx + search.length;
    } else {
      offset = idx + 1;
    }
  }
  const lines = lineNumbersAt(content, offsets);
  return offsets.map((start, i) => ({ start, end: start + search.length, line: lines[i] }));
}

/** 在 content 中执行替换：replaceAll=true 全量，否则只替换第一处。返回新文本与替换次数 */
export function replaceText(
  content: string,
  search: string,
  replace: string,
  options: ReplaceOptions = {},
): { text: string; count: number; matches: TextMatch[] } {
  const matches = findMatches(content, search, options);
  if (matches.length === 0) return { text: content, count: 0, matches };
  const targets = options.replaceAll ?? false ? matches : matches.slice(0, 1);

  let out = '';
  let cursor = 0;
  for (const m of targets) {
    out += content.slice(cursor, m.start) + replace;
    cursor = m.end;
  }
  out += content.slice(cursor);
  return { text: out, count: targets.length, matches };
}

// ============================================================
// 工具定义
// ============================================================

export const replaceStrTool = tool({
  description: `在文件中查找并替换字符串（普通字符串，非正则表达式，字面量精确匹配）。
  默认要求 search 唯一匹配；出现多处时须设置 replaceAll=true 才执行全量替换。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    search: z.string().describe('要被替换的字符串（普通字符串，非正则，字面量精确匹配）'),
    replace: z.string().optional().default('').describe('要替换成的字符串（默认空串，即删除匹配内容）'),
    caseSensitive: z.boolean().optional().default(true).describe('是否大小写敏感（默认 true，字面量精确匹配）'),
    wholeWord: z.boolean().optional().default(false).describe('是否整个单词匹配（匹配边界：前后不能是字母/数字/下划线）'),
    replaceAll: z.boolean().optional().default(false).describe('是否全量替换所有匹配（默认 false；false 时 search 必须唯一匹配，多处匹配会拒绝执行）'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, search, replace, caseSensitive, wholeWord, replaceAll, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'replace', description: '', error: '文件路径为空' }, '❌ 错误：文件路径为空');
    if (!search) return new ToolOutput({ type: 'patch', action: 'replace', description: '', error: 'search 不能为空' }, '❌ 错误：search 不能为空');

    const resolvedPath = resolvePath(filePath);
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, 'utf8');
    } catch (error: any) {
      const errMsg = `读取文件失败: ${error?.message || error}`;
      return new ToolOutput({ type: 'patch', action: 'replace', description: '', error: errMsg }, errMsg);
    }

    const { text: newContent, count, matches } = replaceText(content, search, replace ?? '', {
      caseSensitive: caseSensitive ?? true,
      wholeWord,
      replaceAll: replaceAll ?? false,
    });

    if (count === 0) {
      const mode = `${caseSensitive ?? true ? '大小写敏感' : '大小写不敏感'}${wholeWord ? '·整词' : ''}`;
      return new ToolOutput(
        { type: 'patch', action: 'replace', description: '', error: `未找到匹配 "${search}"` },
        `❌ 未找到匹配 "${search}"（${mode}）`,
      );
    }

    // ── 唯一性约束：非全量模式下多处匹配拒绝执行（dsh str_replace 标准） ──
    if (matches.length > 1 && !(replaceAll ?? false)) {
      const lines = [...new Set(matches.map(m => m.line))].join(', ');
      const errMsg = `"${search}" 在 ${resolvedPath} 第 ${lines} 行出现 ${matches.length} 处，非全量模式下拒绝执行。请提供更具体的 search 使其唯一匹配，或设置 replaceAll=true 全量替换。`;
      return new ToolOutput({ type: 'patch', action: 'replace', description: '', error: errMsg }, `❌ ${errMsg}`);
    }

    // ── 语法检查（非 force） ──
    if (!force) {
      const checkResult = checkSyntax(resolvedPath, newContent);
      if (!checkResult.ok) {
        const errMsg = formatSyntaxErrors(checkResult, {});
        return new ToolOutput({ type: 'patch', action: 'replace', description: '', error: errMsg }, errMsg);
      }
    }

    // ── 写盘 + diff 持久化（可撤销） ──
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const hasTrailingNewline = content.endsWith('\n') || content.endsWith('\r\n');
    // split 会因末尾换行产生空元素，去掉它避免写盘多出空行（与 readFileLines 行为一致）
    const splitLines = (s: string) => {
      const arr = s.split(/\r?\n/);
      if (hasTrailingNewline && arr.length > 1 && arr[arr.length - 1] === '') arr.pop();
      return arr;
    };
    const oldLines = splitLines(content);
    const newLines = splitLines(newContent);

    const truncate = (s: string, n = 30) => (s.length > n ? s.slice(0, n) + '…' : s);
    const description = `替换 "${truncate(search)}" → "${truncate(replace ?? '')}"（${count} 处）`;

    const record = await undoStack.executeWrite(
      resolvedPath, 'replace', description, oldLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = `✅ [REPLACE] 已替换 ${count} 处：${description}\n📄 文件：${resolvedPath}\n📐 行数：${oldLines.length} → ${newLines.length}\n📝 diff 已持久化到：${record.diffFilePath}\n`;
    if (record.diff) msg += '\n--- diff ---\n' + record.diff;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'replace', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});
