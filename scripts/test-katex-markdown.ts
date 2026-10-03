/**
 * 回归：普通消息的 KaTeX 公式渲染（renderMarkdownWithMath）
 *
 * 直接测渲染层的纯函数行为，不依赖浏览器：
 *   - $$…$$ 块级公式 → KaTeX 输出
 *   - \(…\) 行内公式 → KaTeX 输出
 *   - \[…\] 块级公式 → KaTeX 输出
 *   - 代码块/行内代码里的 $ 不被公式化
 *   - 语法错误的公式不抛断，按原文/错误色显示
 *
 * renderMarkdown 依赖 document（escapeHtml 用 document.createElement），
 * 因此这里用一个最小 DOM 垫片。
 */

// ── 最小 DOM 垫片：escapeHtml 只需要 createElement + textContent → innerHTML ──
;(globalThis as any).document = {
  createElement() {
    let text = '';
    return {
      set textContent(v: string) { text = v; },
      get textContent() { return text; },
      get innerHTML() {
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
    };
  },
};

const { renderMarkdownWithMath, renderMarkdown } = await import(
  '../electron/renderer/src/utils/markdown.ts'
);
const { renderKatexInHtml } = await import('../electron/renderer/src/utils/katex-math.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const hasKatex = (html: string) => html.includes('class="katex"');

console.log('\n1. 块级公式 $$…$$');
{
  const html = renderMarkdownWithMath('公式如下：\n\n$$E = mc^2$$\n\n完毕。');
  check('产出 .katex 节点', hasKatex(html));
  check('保留前后普通文本', html.includes('公式如下') && html.includes('完毕'));
  check('非公式部分仍是 markdown 段落', html.includes('<p>'));
}

console.log('\n2. 行内公式 \\(…\\)');
{
  const html = renderMarkdownWithMath('勾股定理 \\(a^2 + b^2 = c^2\\) 成立。');
  check('产出 .katex 节点', hasKatex(html));
  check('行内未被包成块', !html.includes('katex-display'));
}

console.log('\n3. 块级公式 \\[…\\]');
{
  const html = renderMarkdownWithMath('\\[\\int_0^\\infty e^{-x}dx = 1\\]');
  check('产出 .katex 节点', hasKatex(html));
}

console.log('\n4. 代码块里的 $ 不被公式化');
{
  const md = '```js\nconst p = "$$not math$$";\n```';
  const html = renderMarkdownWithMath(md);
  check('代码块保留原文', html.includes('$$not math$$'));
  check('代码块内无 .katex', !hasKatex(html));
}

console.log('\n5. 行内代码里的 $ 不被公式化');
{
  const html = renderMarkdownWithMath('价格是 `$$5` 美元');
  check('行内代码保留原文', html.includes('$$5'));
  check('行内代码内无 .katex', !hasKatex(html));

  const html2 = renderMarkdownWithMath('代码 `$x^2$` 不该渲染');
  check('行内代码里的宽松 $ 也不渲染', !hasKatex(html2));
}

console.log('\n6. 宽松 $…$ —— 像数学才放行');
{
  const priceHtml = renderMarkdownWithMath('这个 $5 和那个 $10 都不该变公式。');
  check('价格 $5 / $10 不触发公式', !hasKatex(priceHtml));

  const mathHtml = renderMarkdownWithMath('行内公式 $x^2 + y^2$ 成立。');
  check('$x^2$ 数学放行', hasKatex(mathHtml));

  const alphaHtml = renderMarkdownWithMath('希腊字母 $\\alpha$ 与 $\\beta$。');
  check('$\\alpha$ 数学放行', hasKatex(alphaHtml));

  const identHtml = renderMarkdownWithMath('变量 $foo$ 是标识符。');
  check('$foo$ 纯标识符放行', hasKatex(identHtml));

  const pathHtml = renderMarkdownWithMath('路径 $/usr/bin$ 不放行。');
  check('$路径$ 不放行', !hasKatex(pathHtml));

  const tplHtml = renderMarkdownWithMath('模板 ${name} 不放行。');
  check('${模板} 不放行', !hasKatex(tplHtml));

  const mixed = renderMarkdownWithMath('价格 $12.5 与 $2.49，但 $\\Delta x$ 是公式。');
  check('价格与公式混排：公式仍渲染', hasKatex(mixed));
  check('混排：价格原文保留', mixed.includes('$12.5'));
}

console.log('\n7. 语法错误的公式不抛断');
{
  let threw = false;
  let html = '';
  try {
    html = renderMarkdownWithMath('坏公式 $$\\frac{1}{$$ 后面还有正文');
    // 未闭合 → 原样保留
  } catch (e) { threw = true; }
  check('未闭合公式不抛异常', !threw);
  check('后续正文仍在', html.includes('后面还有正文'));

  let threw2 = false;
  let html2 = '';
  try {
    html2 = renderKatexInHtml('$$\\undefinedcmd{x}$$');
  } catch (e) { threw2 = true; }
  check('非法命令不抛异常', !threw2);
  check('非法命令产出内容（不空）', html2.length > 0);
}

console.log('\n8. 多公式混排');
{
  const html = renderMarkdownWithMath('$$a$$ 和 \\(b\\) 以及 $$c$$');
  const n = (html.match(/class="katex"/g) || []).length;
  check('三个公式都渲染', n >= 3, `(得到 ${n})`);
}

console.log('\n9. 无公式时与 renderMarkdown 等价');
{
  const md = '# 标题\n\n- 列表项\n- 另一项\n\n**粗体** 与 `代码`';
  check('无公式输出一致', renderMarkdownWithMath(md) === renderMarkdown(md));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
