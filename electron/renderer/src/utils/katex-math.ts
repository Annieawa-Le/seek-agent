/**
 * 普通消息的公式渲染（KaTeX）。
 *
 * 在 markdown 产出的 HTML 字符串上做一次「字符串级」公式替换：把 $$…$$ / \[…\] / \(…\)
 * 就地换成 KaTeX 的 HTML 片段。选字符串级而非 DOM 级，是为了绕开时序问题——
 * DOM 后处理必须在注入之后、且要等 KaTeX 就绪，容易出现「公式一闪而过/永不渲染」；
 * 字符串级在 render 之前就定型，挂载即最终态。
 *
 * 安全边界：
 *   - 只处理 <pre> / <code> 之外的文本（代码块里的 $ 是源码，不该公式化）；
 *   - KaTeX 以 throwOnError:false 渲染，语法错误按原文显示，不会抛断整条消息；
 *   - 不做 $...$ 单美元宽松匹配（价格 $5 会误配），与 VCP 引擎策略一致。
 *   - $...$ 单美元宽松匹配只在「判定像数学」时放行（价格 $5 / 路径 / 模板串不放行），
 *     判定规则移植自 VCP 引擎的 looksLikeSafeSingleDollarMath，两处行为保持一致。
 */
import katex from 'katex';

/** 只注册 $$ / \[ / \( —— 故意不注册宽松 $...$（防价格误配） */
const DELIMS: Array<{ left: string; right: string; display: boolean }> = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
];
/**
 * 单个 $...$ 是否「像数学」。移植自 VCP 引擎，用于把价格/路径/模板串排除在外：
 *   $10 / $12.5      → 数字开头且无数学信号，判为价格，不放行
 *   $/usr/bin$       → 斜杠开头，判为路径，不放行
 *   ${name}          → 花括号包裹，判为模板表达式，不放行
 *   $a|b$            → 含竖线（表格跨列），不放行
 *   $x^2$ / $\alpha$ → 有数学信号，放行
 */
function looksLikeSafeSingleDollarMath(content: string): boolean {
  const t = (content || '').trim();
  if (!t) return false;
  const hasExplicitMathSignal =
    /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|text|mathrm|mathbf|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(t);
  const isSimpleNumericMath = /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|‰|°))?$/.test(t);
  const isSimpleIdentifierMath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(t);
  if (/^\d/.test(t) && !hasExplicitMathSignal && !isSimpleNumericMath) return false;
  if (t.charAt(0) === '/') return false;
  if (t.charAt(0) === '{' && t.charAt(t.length - 1) === '}') return false;
  if (t.indexOf('|') !== -1) return false;
  return hasExplicitMathSignal || isSimpleNumericMath || isSimpleIdentifierMath;
}

/**
 * 把文本中「安全的 $...$」转成 \(...\)，交给后续统一渲染。
 * 字符级扫描：不安全的候选只释放开头那个 $，不吞掉后面的内容，
 * 因此「$12.5 ... $2.49 ... $\Delta...$」不会因价格误配而跳过后面真正的公式。
 */
function convertSafeDollarMath(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const openIndex = text.indexOf('$', index);
    if (openIndex === -1) { result += text.slice(index); break; }
    result += text.slice(index, openIndex);
    const prev = text.charAt(openIndex - 1);
    const nextOpen = text.charAt(openIndex + 1);
    // 转义的 \$ / 已经是 $$ 的一半 / 前面贴着单词（如 US$5）→ 不当作公式起点
    if (prev === '\\' || prev === '$' || nextOpen === '$' || /\w/.test(prev)) {
      result += '$'; index = openIndex + 1; continue;
    }
    let closeIndex = -1;
    let cursor = openIndex + 1;
    while (cursor < text.length) {
      const dollarIndex = text.indexOf('$', cursor);
      if (dollarIndex === -1) break;
      if (text.charAt(dollarIndex - 1) === '\\') { cursor = dollarIndex + 1; continue; }
      // 收尾 $ 后面紧跟单词字符 → 不是闭合（如 $5$abc）
      if (!/\w/.test(text.charAt(dollarIndex + 1))) { closeIndex = dollarIndex; break; }
      cursor = dollarIndex + 1;
    }
    if (closeIndex === -1) { result += '$'; index = openIndex + 1; continue; }
    const content = text.slice(openIndex + 1, closeIndex);
    // 超长 / 跨行 / 不像数学 → 放弃这一对，只释放开头 $
    if (content.length > 1200 || content.indexOf('\n') !== -1 || !looksLikeSafeSingleDollarMath(content)) {
      result += '$'; index = openIndex + 1; continue;
    }
    result += '\\(' + content.trim() + '\\)';
    index = closeIndex + 1;
  }
  return result;
}


/**
 * 把一段纯文本里的公式替换为 KaTeX HTML。
 * text 必须是「已经 HTML 转义过」的文本片段（markdown 渲染器产出），
 * 因此这里看到的是字面量 $ 与反斜杠，不会遇到裸标签。
 */
function renderMathInText(text: string): string {
  // 先把「安全的 $...$」归一成 \(...\)，再走统一的定界符替换。
  // 必须在 $$ 之前做：转换器会跳过 $$（nextOpen === '$'），不会吃掉块级公式。
  let out = convertSafeDollarMath(text);
  for (const d of DELIMS) {
    // 逐处匹配并替换；左右定界符都要存在且非空
    let result = '';
    let cursor = 0;
    while (cursor < out.length) {
      const start = out.indexOf(d.left, cursor);
      if (start === -1) break;
      const end = out.indexOf(d.right, start + d.left.length);
      if (end === -1) break;
      const body = out.slice(start + d.left.length, end);
      // 空公式或跨太多内容（超过 2000 字符）不处理，避免吞掉大段文本
      if (body.length > 0 && body.length < 2000) {
        result += out.slice(cursor, start);
        try {
          result += katex.renderToString(body, {
            displayMode: d.display,
            throwOnError: false,
            strict: 'ignore',
          });
        } catch {
          // 渲染失败保留原始源码，不影响其余内容
          result += out.slice(start, end + d.right.length);
        }
      } else {
        result += out.slice(cursor, end + d.right.length);
      }
      cursor = end + d.right.length;
    }
    result += out.slice(cursor);
    out = result;
  }
  return out;
}

/**
 * 对 markdown 产出的 HTML 做公式渲染。
 * 按 <pre>/<code> 切段，只在段外做替换——代码块/行内代码里的 $ 保持原样。
 */
export function renderKatexInHtml(html: string): string {
  if (!html || (html.indexOf('$') === -1 && html.indexOf('\\(') === -1 && html.indexOf('\\[') === -1)) {
    return html;
  }
  // 切开 <pre…>…</pre> 与 <code…>…</code>，仅对非代码段做公式替换
  const parts = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/gi);
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    const isCode = /^<(pre|code)[\s>]/i.test(segment);
    if (!isCode) parts[i] = renderMathInText(segment);
  }
  return parts.join('');
}


