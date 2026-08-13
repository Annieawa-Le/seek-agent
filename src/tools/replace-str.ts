/**
 * replace-str.ts — 快速字符串替换工具
 *
 * 编辑器式替换：普通字符串（非正则）查找替换，支持大小写敏感 / 整个单词 / 全部替换选项。
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
  /** 大小写敏感（默认 false，与编辑器默认一致） */
  caseSensitive?: boolean;
  /** 整个单词匹配：匹配边界前后不能是字母/数字/下划线（默认 false） */
  wholeWord?: boolean;
  /** 全部替换（默认 true；false 只替换第一处） */
  replaceAll?: boolean;
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

/** 在 content 中查找并替换 search（普通字符串，非正则），返回新文本与替换次数 */
export function replaceText(
  content: string,
  search: string,
  replace: string,
  options: ReplaceOptions = {},
): { text: string; count: number } {
  if (!search) return { text: content, count: 0 };
  const caseSensitive = options.caseSensitive ?? false;
  const wholeWord = options.wholeWord ?? false;
  const replaceAll = options.replaceAll ?? true;

  const haystack = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? search : search.toLowerCase();

  let out = '';
  let count = 0;
  let i = 0;
  while (i < content.length) {
    if (haystack.startsWith(needle, i) && (!wholeWord || isWordBoundary(content, i, i + search.length))) {
      out += replace;
      count++;
      i += search.length;
      if (!replaceAll) {
        out += content.slice(i);
        i = content.length;
      }
    } else {
      out += content[i];
      i++;
    }
  }
  return { text: out, count };
}

// ============================================================
// 工具定义
// ============================================================

export const replaceStrTool = tool({
  description: `快速字符串替换工具（编辑器式替换选项）。
  在文件中查找并替换字符串（普通字符串，非正则表达式），支持大小写敏感 / 整个单词 / 全部替换等选项。
  每次替换做语法检查（可 force 跳过）并持久化 diff，可用 undo_patch 撤销。
  适用场景：变量改名、常量值替换、删除特定字符串等。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径或相对当前工作目录的路径'),
    search: z.string().describe('要被替换的字符串（普通字符串，非正则表达式）'),
    replace: z.string().optional().default('').describe('要替换成的字符串（默认空串，即删除匹配内容）'),
    caseSensitive: z.boolean().optional().default(false).describe('是否大小写敏感（默认 false，大小写不敏感）'),
    wholeWord: z.boolean().optional().default(false).describe('是否整个单词匹配（匹配边界：前后不能是字母/数字/下划线）'),
    replaceAll: z.boolean().optional().default(true).describe('是否替换所有匹配（默认 true；false 时只替换第一处）'),
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

    const { text: newContent, count } = replaceText(content, search, replace ?? '', { caseSensitive, wholeWord, replaceAll });
    if (count === 0) {
      const mode = `${caseSensitive ? '大小写敏感' : '大小写不敏感'}${wholeWord ? '·整词' : ''}`;
      return new ToolOutput(
        { type: 'patch', action: 'replace', description: '', error: `未找到匹配 "${search}"` },
        `❌ 未找到匹配 "${search}"（${mode}）`,
      );
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

