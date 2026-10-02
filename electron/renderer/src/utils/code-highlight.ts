/* ═══════════════════════════════════════════════════════════
   轻量语法高亮：正则 token 表（注释 / 字符串 / 数字 / 关键字 / 标识符）

   不引依赖，够用即可。编辑器与内联差异视图共用同一套着色，避免两处
   呈现出不同颜色。
   ═══════════════════════════════════════════════════════════ */

const KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'new', 'class', 'extends', 'super', 'this', 'import', 'from', 'export', 'default', 'try', 'catch',
  'finally', 'throw', 'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of', 'null', 'undefined', 'true',
  'false', 'void', 'delete', 'static', 'public', 'private', 'protected', 'readonly', 'interface', 'type', 'enum',
  'implements', 'namespace', 'declare', 'as', 'satisfies', 'def', 'elif', 'lambda', 'pass', 'with', 'and', 'or',
  'not', 'is', 'None', 'True', 'False', 'struct', 'impl', 'fn', 'pub', 'mut', 'use', 'mod', 'match', 'where',
  'package', 'func', 'defer', 'chan', 'select', 'nil', 'abstract', 'final', 'synchronized',
];

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Highlighters {
  keywordRe: RegExp;
  tokenRe: RegExp;
}

/** 构建一组高亮正则。`tokenRe` 带 g 标志，复用时会由 highlightLine 复位 lastIndex */
export function createHighlighters(): Highlighters {
  return {
    keywordRe: new RegExp(`^(?:${KEYWORDS.map(escapeRegExp).join('|')})$`),
    // 顺序即优先级：注释 → 字符串 → 数字 → 标识符/关键字
    tokenRe: /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*|"[^"\n]*"|'[^'\n]*'|`[^`]*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*/g,
  };
}

/** 逐行高亮，返回可直接交给 dangerouslySetInnerHTML 的 HTML 片段 */
export function highlightLine(line: string, keywordRe: RegExp, tokenRe: RegExp): string {
  let out = '';
  let last = 0;
  tokenRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, m.index));
    const text = m[0];
    let cls = 'tok-plain';
    if (text.startsWith('//') || text.startsWith('#') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('--')) cls = 'tok-comment';
    else if (text.startsWith('"') || text.startsWith("'") || text.startsWith('`')) cls = 'tok-string';
    else if (/^\d/.test(text)) cls = 'tok-number';
    else if (keywordRe.test(text)) cls = 'tok-keyword';
    else cls = 'tok-ident';
    out += `<span class="${cls}">${escapeHtml(text)}</span>`;
    last = m.index + text.length;
    // 零宽匹配保护：避免正则异常时死循环
    if (m.index === tokenRe.lastIndex) tokenRe.lastIndex += 1;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

let cached: Highlighters | null = null;

/** 多行高亮（内部复用同一组正则，避免逐行重建） */
export function highlightLines(lines: string[]): string[] {
  const hl = (cached ??= createHighlighters());
  return lines.map(l => highlightLine(l, hl.keywordRe, hl.tokenRe));
}
