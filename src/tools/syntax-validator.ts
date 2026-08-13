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
 *
 * Python 例外：.py/.pyw 一律跳过语法检查（含替换块预检）。原因：通用括号平衡检查
 * 不认识 Python 的 # 注释与三引号字符串，注释/docstring 中的括号会被误报为未闭合，
 * 导致正常写入被拦截；而 Python 靠缩进表达块结构，括号平衡检查对它的保护价值很低。
 * 若需真实检查应接入 `python -m py_compile` / ast.parse。
 *
 * 全局开关：设置环境变量 SEEK_DISABLE_SYNTAX_CHECK=1 时，所有文件类型跳过语法检查。
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
  // Python 文件跳过语法检查：通用括号检查不识别 # 注释/三引号，会误报拦截正常写入
  if (isPythonFile(filePath)) return { ok: true, errors: [] };
  // 全局开关：SEEK_DISABLE_SYNTAX_CHECK=1 时所有文件类型跳过语法检查
  if (process.env.SEEK_DISABLE_SYNTAX_CHECK === '1') return { ok: true, errors: [] };

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

function isPythonFile(filePath: string): boolean {
  const ext = getExtension(filePath).toLowerCase();
  return ext === '.py' || ext === '.pyw';
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
 * 传入 newLines（修改后内容）时，额外追加"修改后模拟状态"预览：
 * 错误位置附近的上下文 + 替换区域标记（+ 为替换区域行，⚠ 为语法错误位置）。
 * replaceRange 标注替换块在 newLines 中的 1-based 行号范围：
 *   提供时只逐条展示替换区域内的错误，区域外错误（多为级联误报）折叠为一行汇总提示；
 *   preview 也仅基于区域内错误行生成。
 * precheck 为替换块自身的结构预检结果（P0）。
 */
export function formatSyntaxErrors(
  result: SyntaxCheckResult,
  options?: {
    oldLines?: string[];
    newLines?: string[];
    /** 替换块在 newLines 中的 1-based 行号范围（用于错误定位映射） */
    replaceRange?: { start: number; end: number };
    /** 替换块结构预检结果（P0），非 null 且不通过时在最前给出修正方向 */
    precheck?: ReplacementPrecheck;
  },
): string {
  if (result.ok) return '';

  const lines: string[] = ['插入未成功！本次操作已回滚，因为语法检查发现以下可能问题：'];

  // 替换块预检提示（最可能的根因放最前，避免模型陷入"怀疑语法检查器/行号"的猜测螺旋）
  if (options?.precheck && !options.precheck.ok) {
    lines.push('', '── 替换块结构预检（仅检查你提交的替换块自身） ──');
    for (const issue of options.precheck.issues) {
      lines.push(`  ⚠ 替换块第 ${issue.line} 行：${issue.message}`);
    }
    lines.push('  提示：替换块自身括号/标签不平衡是整文件级联报错的最常见根因，优先修正替换块再重试。');
  }

  // 区域过滤：提供 replaceRange 时只展示替换区域内的错误。
  // 区域外错误多为替换块不平衡引发的级联误报（错误全跑文件末尾），逐条列出只会误导，折叠为一行汇总。
  let filteredErrors = result.errors;
  let outsideCount = 0;
  if (options?.replaceRange) {
    const { start, end } = options.replaceRange;
    filteredErrors = [];
    for (const err of result.errors) {
      if (err.line && err.line >= start && err.line <= end) filteredErrors.push(err);
      else outsideCount++;
    }
  }

  for (const err of filteredErrors) {
    const pos = err.line ? `第 ${err.line} 行` : '';
    const col = err.column ? `:${err.column}` : '';
    let region = '';
    if (options?.replaceRange && err.line) {
      const { start } = options.replaceRange;
      region = ` [替换区域内·相对替换块第 ${err.line - start + 1} 行]`;
    }
    lines.push(`  ${pos}${col}  ${err.message}${region}`);
  }

  if (outsideCount > 0) {
    lines.push(`  ...另有 ${outsideCount} 条错误位于替换区域外，已省略（替换块不平衡常引发区域外级联报错；若预检通过，请检查替换范围边界是否切断了原有结构）`);
  }
  if (options?.newLines && options.newLines.length > 0) {
    const preview = buildSyntaxPreview(options.newLines, filteredErrors, options.replaceRange);
    if (preview) lines.push('', preview);
  }
  lines.push('💡 如果你确认修改无误，可以添加 force: true 参数跳过检查');
  return lines.join('\n');
}

/**
 * 生成"修改后模拟状态"预览：错误行附近的上下文（带行号），
 * 标记替换区域行（+，基于 replaceRange）与语法错误所在行（⚠）。
 * 行号与内容均基于修改后的 newLines。
 */
function buildSyntaxPreview(
  newLines: string[],
  errors: SyntaxError[],
  replaceRange?: { start: number; end: number },
): string {
  const WINDOW = 4; // 错误行前后展示的行数
  const errorLines = errors
    .map(e => e.line)
    .filter((l): l is number => typeof l === 'number' && l >= 1 && l <= newLines.length);
  if (errorLines.length === 0) return '';

  // 合并各错误行的展示窗口（±WINDOW）
  const ranges: [number, number][] = errorLines
    .map(l => [Math.max(1, l - WINDOW), Math.min(newLines.length, l + WINDOW)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const errorSet = new Set(errorLines);
  const out: string[] = ['── 修改后模拟状态（应用修改后的文件预览；+ 替换区域行，⚠ 语法错误位置） ──'];
  for (const [s, e] of merged) {
    for (let i = s; i <= e; i++) {
      const content = newLines[i - 1] ?? '';
      const inRange = replaceRange ? i >= replaceRange.start && i <= replaceRange.end : false;
      const marker = errorSet.has(i) ? '⚠' : inRange ? '+' : ' ';
      out.push(`  ${marker}${String(i).padStart(4)} │ ${content}`);
    }
    if (merged.length > 1 && e !== merged[merged.length - 1][1]) out.push('  ...');
  }
  return out.join('\n');
}







// ============================================================
// 替换块结构预检（P0：级联报错根因定位）
// ============================================================

export interface ReplacementIssue {
  message: string;
  /** 替换块内 1-based 行号 */
  line: number;
}

export interface ReplacementPrecheck {
  ok: boolean;
  issues: ReplacementIssue[];
}

/**
 * 对"将要插入/替换的代码块"单独做括号与标签平衡预检。
 * 替换块自身的括号/标签不平衡，是整文件语法检查出现级联报错（错误全跑文件末尾）的最常见根因。
 * 该预检是提示性的：不通过也不会拦截（合法的不完整块存在），但会给模型明确的修正方向。
 */
export function precheckReplacement(filePath: string, lines: string[]): ReplacementPrecheck {
  // Python 文件跳过预检（与 checkSyntax 保持一致，避免 # 注释/三引号误报）
  if (isPythonFile(filePath)) return { ok: true, issues: [] };
  if (process.env.SEEK_DISABLE_SYNTAX_CHECK === '1') return { ok: true, issues: [] };

  const ext = getExtension(filePath).toLowerCase();
  const issues: ReplacementIssue[] = scanBracketBalance(lines);
  if (ext === '.tsx' || ext === '.jsx' || ext === '.html' || ext === '.htm') {
    issues.push(...scanTagBalance(lines));
  }
  return { ok: issues.length === 0, issues };
}

/** 括号平衡扫描：跳过字符串/注释/模板字符串，定位不匹配的具体行 */
function scanBracketBalance(lines: string[]): ReplacementIssue[] {
  const issues: ReplacementIssue[] = [];
  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const openSet = new Set(['{', '[', '(']);
  const closeSet = new Set(['}', ']', ')']);

  for (let li = 0; li < lines.length; li++) {
    const cleaned = stripStringsAndComments(lines[li]);
    for (const ch of cleaned) {
      if (openSet.has(ch)) {
        stack.push({ char: ch, line: li + 1 });
      } else if (closeSet.has(ch)) {
        if (stack.length === 0) {
          issues.push({ message: `多余的闭括号 ${ch}`, line: li + 1 });
        } else {
          const last = stack[stack.length - 1];
          if (pairs[last.char] !== ch) {
            issues.push({ message: `括号不匹配：期望 ${pairs[last.char]}，实际 ${ch}（打开于第 ${last.line} 行）`, line: li + 1 });
          } else {
            stack.pop();
          }
        }
      }
    }
  }
  for (const item of stack) {
    issues.push({ message: `未闭合的括号 ${item.char}（打开于第 ${item.line} 行）`, line: item.line });
  }
  return issues;
}

/** JSX/HTML 标签配对扫描：定位未闭合/多余的标签及其行号 */
function scanTagBalance(lines: string[]): ReplacementIssue[] {
  const issues: ReplacementIssue[] = [];
  const stack: Array<{ tag: string; line: number }> = [];
  const tagRegex = /<\/?([A-Za-z][A-Za-z0-9._-]*)\b[^>]*>/g;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    tagRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(line)) !== null) {
      const full = m[0];
      const tag = m[1];
      if (full.startsWith('<!--')) continue;
      if (SELF_CLOSING_TAGS.has(tag.toLowerCase())) continue;
      if (full.trimEnd().endsWith('/>')) continue; // JSX/XML 自闭合
      if (full.startsWith('</')) {
        if (stack.length === 0) {
          issues.push({ message: `多余的闭合标签 </${tag}>`, line: li + 1 });
        } else {
          const last = stack[stack.length - 1];
          if (last.tag !== tag) {
            issues.push({ message: `标签不匹配：</${tag}> 期望闭合 <${last.tag}>（打开于第 ${last.line} 行）`, line: li + 1 });
          } else {
            stack.pop();
          }
        }
      } else {
        stack.push({ tag, line: li + 1 });
      }
    }
  }
  for (const item of stack) {
    issues.push({ message: `未闭合的标签 <${item.tag}>（打开于第 ${item.line} 行）`, line: item.line });
  }
  return issues;
}









