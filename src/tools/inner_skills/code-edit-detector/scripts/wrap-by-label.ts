import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../../workdir.js';
import { ToolOutput } from '../../../tool-output.js';
import { undoStack } from '../../../patch-undo.js';
import { checkSyntax, formatSyntaxErrors } from '../../../syntax-validator.js';
import { getLeadingWhitespace, detectIndentUnit } from './wrap-by.js';

/**
 * 用 HTML/JSX/XML 标签包裹指定行范围，范围内自动增加一级缩进。
 * 与 wrap_by（花括号包裹）互补：嵌套结构编辑优先用标签包裹，
 * 避免模型手写开/闭标签时引入不平衡。
 */
export const wrapByLabel = tool({
  description: `用 HTML/JSX/XML 标签包裹指定行范围，并在范围内自动增加一级缩进。
  例如将 2-4 行用 <div className="card"> 包裹，会生成：
    <div className="card">
      ...原有第2行...
      ...原有第3行...
      ...原有第4行...
    </div>
  tagName 只填标签名（如 div、section、span、MyComponent），attrs 填属性字符串（如 className="card"、style={{ display: "flex" }}）。
  与 patch 工具一致：语法检查 + diff 持久化，可用 undo_patch() 撤销。`,
  inputSchema: z.object({
    filePath: z.string().describe('目标文件的路径（绝对路径或相对当前工作目录的路径）'),
    startLine: z.number().describe('起始行号（从 1 开始，包含该行）'),
    endLine: z.number().describe('结束行号（从 1 开始，包含该行）'),
    tagName: z.string().describe('标签名，如 div、span、section、MyComponent（不含尖括号）'),
    attrs: z.string().optional().describe('可选：标签属性字符串，如 className="card" 或 style={{ display: "flex" }}'),
    force: z.boolean().optional().default(false).describe('跳过语法检查'),
  }),
  execute: async ({ filePath, startLine, endLine, tagName, attrs, force }) => {
    if (!filePath?.trim()) return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: '文件路径为空' }, '❌ 错误：文件路径为空');
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tagName ?? '')) {
      return new ToolOutput({ type: 'patch', action: 'modify', description: '', error: `无效的标签名 "${tagName}"` }, `❌ 无效的标签名 "${tagName}"。只允许字母开头，可含字母/数字/下划线/点/连字符。`);
    }

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

    // 基准缩进 = 起始行的前导空白；一级缩进单位从文件推断
    const baseIndent = getLeadingWhitespace(lines[startLine - 1]);
    const unit = detectIndentUnit(lines, startLine, endLine);
    const innerIndent = baseIndent + unit;

    const openTag = `<${tagName}${attrs ? ` ${attrs}` : ''}>`;
    const closeTag = `</${tagName}>`;

    const oldLines = lines;
    const newLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1; // 1-based
      if (lineNum === startLine) newLines.push(`${baseIndent}${openTag}`);
      if (lineNum >= startLine && lineNum <= endLine) {
        // 新缩进 = 新基准(innerIndent) + 原行相对基准行的额外缩进（保留原风格，避免重复累加）
        const origWs = getLeadingWhitespace(lines[i]);
        const relWs = origWs.slice(baseIndent.length);
        newLines.push(innerIndent + relWs + lines[i].trimStart());
      }
      if (lineNum === endLine) newLines.push(`${baseIndent}${closeTag}`);
      if (lineNum < startLine || lineNum > endLine) newLines.push(lines[i]);
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
    const description = `用 ${openTag} ... ${closeTag} 包裹 ${rangeDesc}`;

    const record = await undoStack.executeWrite(
      resolvedPath, 'modify', description, oldLines, newLines, hasTrailingNewline, lineEnding,
      async (nl: string[]) => { await fs.writeFile(resolvedPath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8'); },
    );

    let msg = `✅ [WRAP] ${description}\n📄 文件：${resolvedPath}\n📐 行数：${oldLines.length} → ${newLines.length}\n📝 diff 已持久化到：${record.diffFilePath}\n`;
    msg += `\n${baseIndent}${openTag}\n${innerIndent}... ${endLine - startLine + 1} 行 ...\n${baseIndent}${closeTag}\n`;
    if (record.diff) msg += '\n--- diff ---\n' + record.diff;
    msg += '\n💡 如需撤销：undo_patch()';
    return new ToolOutput({ type: 'patch', action: 'modify', description, filePath: resolvedPath, diff: record.diff, undoId: record.meta.id }, msg);
  },
});



