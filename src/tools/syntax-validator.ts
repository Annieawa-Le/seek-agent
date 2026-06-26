/**
 * syntax-validator.ts — 文件语法校验工具
 *
 * 在 patch 写入前对修改后的内容做语法检查，检测可能引入语法错误（如未闭合的大括号等）。
 * 支持文件类型：
 *   .ts/.tsx  → TypeScript compiler API（parse + diagnostics）
 *   .js/.jsx  → TypeScript compiler API（JS 模式）
 *   .json     → JSON.parse
 *   .html/.htm → 标签平衡检测
 *   .css/.scss → 大括号平衡检测
 *   其他      → 通用大括号/方括号/圆括号/尖括号平衡检测
 */

import ts from 'typescript';

// ============================================================
// 主入口
// ============================================================

export interface SyntaxCheckResult {
  ok: boolean;
  errors: SyntaxError[];
}

export interface SyntaxError {
  message: string;
  line?: number;
  column?: number;
}

/**
 * 检查文件内容是否存在语法错误。
 * filePath 用于推断语言类型（扩展名）。
 * content 是修改后的完整文件内容。
 */
export function checkSyntax(filePath: string, content: string): SyntaxCheckResult {
  const ext = getExtension(filePath).toLowerCase();

  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
      return checkTypeScript(content, ext);
    case '.json':
      return checkJson(content);
    case '.html':
    case '.htm':
      return checkHtml(content);
    case '.css':
    case '.scss':
    case '.less':
      return checkBraceBalance(content, ext);
    default:
      // 对未知类型的文件做通用括号平衡检测
      return checkGenericBrackets(content);
  }
}

// ============================================================
// TypeScript / JavaScript 校验
// ============================================================

function checkTypeScript(content: string, ext: string): SyntaxCheckResult {
  const errors: SyntaxError[] = [];

  // 根据扩展名确定 scriptKind
  let scriptKind: ts.ScriptKind;
  switch (ext) {
    case '.tsx':
      scriptKind = ts.ScriptKind.TSX;
      break;
    case '.jsx':
      scriptKind = ts.ScriptKind.JSX;
      break;
    case '.js':
      scriptKind = ts.ScriptKind.JS;
      break;
    default:
      scriptKind = ts.ScriptKind.TS;
  }

  // 用空白的 compilerHost 做快速 parse
  const sourceFile = ts.createSourceFile(
    `file${ext}`,
    content,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );

  // 通过 syntactic diagnostics 检查
  const rawDiags = (sourceFile as any).parseDiagnostics as ts.Diagnostic[] | undefined;
  const diags = rawDiags || [];

  for (const diag of diags) {
    if (diag.category === ts.DiagnosticCategory.Error) {
      const pos = diag.start != null ? sourceFile.getLineAndCharacterOfPosition(diag.start) : null;
      errors.push({
        message: typeof diag.messageText === 'string'
          ? diag.messageText
          : (diag.messageText as ts.DiagnosticMessageChain).messageText,
        line: pos ? pos.line + 1 : undefined,
        column: pos ? pos.character + 1 : undefined,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================
// JSON 校验
// ============================================================

function checkJson(content: string): SyntaxCheckResult {
  const errors: SyntaxError[] = [];
  try {
    JSON.parse(content);
  } catch (e: any) {
    // 从错误消息中尝试提取行号
    const match = e.message?.match(/position\s+(\d+)/i) || e.message?.match(/at\s+(\d+)/i);
    if (match) {
      const pos = parseInt(match[1], 10);
      const line = content.slice(0, pos).split('\n').length;
      errors.push({ message: e.message, line });
    } else {
      errors.push({ message: e?.message || 'JSON 解析错误' });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ============================================================
// HTML 标签平衡检测
// ============================================================

const SELF_CLOSING_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function checkHtml(content: string): SyntaxCheckResult {
  const errors: SyntaxError[] = [];
  // 简单正则提取开标签和闭标签，纯文本/脚本/样式中的 > 会影响准确性，
  // 但作为一个快速校验已经足够
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

  const stack: Array<{ tag: string; line: number }> = [];
  const lines = content.split('\n');

  // 分行检测，以定位错误行号
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let match: RegExpExecArray | null;
    tagRegex.lastIndex = 0;

    while ((match = tagRegex.exec(line)) !== null) {
      const fullTag = match[0];
      const tagName = match[1].toLowerCase();

      // 忽略自闭合标签和 DOCTYPE
      if (SELF_CLOSING_TAGS.has(tagName)) continue;
      if (fullTag.endsWith('/>')) continue;
      if (tagName === '!doctype') continue;

      if (fullTag.startsWith('</')) {
        // 闭标签
        if (stack.length === 0) {
          errors.push({
            message: `多余的闭标签 </${tagName}>`,
            line: lineIdx + 1,
          });
        } else {
          const last = stack.pop()!;
          if (last.tag !== tagName) {
            errors.push({
              message: `标签不匹配：</${tagName}> 期望关闭 <${last.tag}>`,
              line: lineIdx + 1,
            });
          }
        }
      } else {
        // 开标签
        stack.push({ tag: tagName, line: lineIdx + 1 });
      }
    }
  }

  // 栈中剩余的开标签
  for (const item of stack) {
    errors.push({
      message: `未闭合的标签 <${item.tag}>`,
      line: item.line,
    });
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================
// 大括号平衡检测（CSS/SCSS/LESS）
// ============================================================

function checkBraceBalance(content: string, _ext: string): SyntaxCheckResult {
  const errors: SyntaxError[] = [];

  let stack: Array<{ char: string; line: number }> = [];

  // 先忽略字符串/注释内容
  const cleaned = stripStringsAndComments(content);

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') {
      const lineNum = content.slice(0, i).split('\n').length;
      stack.push({ char: '{', line: lineNum });
    } else if (ch === '}') {
      if (stack.length === 0) {
        const lineNum = content.slice(0, i).split('\n').length;
        errors.push({ message: '多余的闭括号 }', line: lineNum });
      } else {
        stack.pop();
      }
    }
  }

  for (const item of stack) {
    errors.push({ message: `未闭合的大括号 {`, line: item.line });
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================
// 通用括号平衡检测（未知文件类型）
// ============================================================

function checkGenericBrackets(content: string): SyntaxCheckResult {
  const errors: SyntaxError[] = [];

  // 跳过字符串和注释
  const cleaned = stripStringsAndComments(content);
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const openSet = new Set(['{', '[', '(']);
  const closeSet = new Set(['}', ']', ')']);

  const stack: Array<{ char: string; line: number }> = [];

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (openSet.has(ch)) {
      const lineNum = content.slice(0, i).split('\n').length;
      stack.push({ char: ch, line: lineNum });
    } else if (closeSet.has(ch)) {
      if (stack.length === 0) {
        const lineNum = content.slice(0, i).split('\n').length;
        errors.push({ message: `多余的闭括号 ${ch}`, line: lineNum });
      } else {
        const last = stack[stack.length - 1];
        if (pairs[last.char] !== ch) {
          const lineNum = content.slice(0, i).split('\n').length;
          errors.push({ message: `括号不匹配：期望 ${pairs[last.char]}，实际 ${ch}`, line: lineNum });
        } else {
          stack.pop();
        }
      }
    }
  }

  for (const item of stack) {
    errors.push({ message: `未闭合的括号 ${item.char}`, line: item.line });
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================
// 辅助函数
// ============================================================

function getExtension(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  if (idx === -1) return '';
  // 处理 .d.ts 等情况
  const ext = filePath.slice(idx);
  if (ext === '.d.ts') return '.ts';
  return ext;
}

/**
 * 移除字符串和注释内容，避免其中的括号干扰平衡检测。
 * 处理：单行注释 //，多行注释 /* * /，单引号/双引号/模板字符串。
 */
function stripStringsAndComments(content: string): string {
  const result: string[] = [];
  const len = content.length;
  let i = 0;

  while (i < len) {
    // 单行注释
    if (content[i] === '/' && content[i + 1] === '/') {
      while (i < len && content[i] !== '\n') i++;
      continue;
    }
    // 多行注释
    if (content[i] === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < len && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 模板字符串
    if (content[i] === '`') {
      i++;
      while (i < len && content[i] !== '`') {
        if (content[i] === '\\') i++; // 跳过转义
        i++;
      }
      i++;
      continue;
    }
    // 单引号或双引号字符串
    if (content[i] === "'" || content[i] === '"') {
      const quote = content[i];
      i++;
      while (i < len && content[i] !== quote) {
        if (content[i] === '\\') i++; // 跳过转义
        i++;
      }
      i++; // 跳过闭引号
      continue;
    }
    // 普通字符，仅保留括号类字符
    if ('{}[]()'.includes(content[i])) {
      result.push(content[i]);
    }
    i++;
  }

  return result.join('');
}

// ============================================================
/**
 * 将 SyntaxCheckResult 格式化为用户可读的错误消息。
 * 如果校验通过返回空字符串。
 */
export function formatSyntaxErrors(result: SyntaxCheckResult): string {
  if (result.ok) return '';

  const lines: string[] = ['⚠️ 语法检查发现以下可能问题：'];
  for (const err of result.errors) {
    const pos = err.line ? `第 ${err.line} 行` : '';
    const col = err.column ? `:${err.column}` : '';
    lines.push(`  ${pos}${col}  ${err.message}`);
  }
  lines.push('💡 如果你确认修改无误，可以添加 force: true 参数跳过检查');
  return lines.join('\n');
}




