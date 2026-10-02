/**
 * 审查追问（选区工具栏）的纯逻辑测试。
 *
 * 拖拽落点的 DOM 命中需要真实浏览器才能跑，这里只测可独立验证的部分：
 *   - 代码块围栏的格式（文件名、行号范围、语言标注）
 *   - 三个动作生成的提示词是否都带上了代码块
 *   - 行号换算（选区偏移 → 起止行）
 *
 * 运行：pnpm tsx scripts/test-review-ask.ts
 */
// 直接引 .tsx 里的纯导出：该文件顶层没有副作用（只声明组件与常量）
import { REVIEW_ACTIONS, buildFence, type ReviewContext } from '../electron/renderer/src/components/SelectionToolbar.tsx';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 复刻 FileEditor.syncSelection 里的行号换算，验证边界 */
function lineRangeOf(text: string, start: number, end: number) {
  const code = text.slice(start, end);
  const startLine = text.slice(0, start).split('\n').length;
  const endLine = startLine + code.split('\n').length - 1;
  return { startLine, endLine };
}

console.log('\n[1] 代码块围栏格式');
{
  const base = {
    code: 'const x = 1;\nconst y = 2;',
    filePath: 'D:/proj/src/a.ts',
    startLine: 10,
    endLine: 11,
  };
  const fence = buildFence(base);
  check('标注了文件路径', fence.includes('D:/proj/src/a.ts'));
  check('标注了行号范围', fence.includes('第 10-11 行'), fence);
  check('使用了 ts 语言标注', fence.includes('```ts'), fence);
  check('包含代码原文', fence.includes('const x = 1;') && fence.includes('const y = 2;'));
  check('围栏成对闭合', (fence.match(/```/g) || []).length === 2, fence);

  const single = buildFence({ ...base, code: 'const x = 1;', endLine: 10 });
  check('单行选区只标一个行号', single.includes('第 10 行'), single);
}

console.log('\n[2] 三个动作的提示词');
{
  const ctx: ReviewContext = {
    code: 'foo();',
    filePath: 'D:/p/b.js',
    startLine: 3,
    endLine: 3,
    fence: buildFence({ code: 'foo();', filePath: 'D:/p/b.js', startLine: 3, endLine: 3 }),
  };
  check('共 3 个动作', REVIEW_ACTIONS.length === 3);
  check('动作键为 不懂/有误/推荐', REVIEW_ACTIONS.map(a => a.label).join(',') === '不懂,有误,推荐');

  for (const a of REVIEW_ACTIONS) {
    const p = a.buildPrompt(ctx);
    check(`「${a.label}」提示词含代码块`, p.includes('```js') && p.includes('foo();'), p);
    check(`「${a.label}」提示词含文件出处`, p.includes('D:/p/b.js'), p);
    check(`「${a.label}」提示词非空且带追问意图`, p.trim().length > 20);
  }

  // 三个动作的提示词必须互不相同，否则用户分不出差别
  const prompts = REVIEW_ACTIONS.map(a => a.buildPrompt(ctx));
  check('三个提示词互不相同', new Set(prompts).size === 3);
}

console.log('\n[3] 选区行号换算');
{
  const text = ['line1', 'line2', 'line3', 'line4'].join('\n');

  check('选中第 1 行', JSON.stringify(lineRangeOf(text, 0, 5)) === JSON.stringify({ startLine: 1, endLine: 1 }));
  check('选中第 2 行', JSON.stringify(lineRangeOf(text, 6, 11)) === JSON.stringify({ startLine: 2, endLine: 2 }));

  // 跨行：从第 2 行行首选到第 3 行行尾
  const spanStart = text.indexOf('line2');
  const spanEnd = text.indexOf('line3') + 'line3'.length;
  check('跨两行选区', JSON.stringify(lineRangeOf(text, spanStart, spanEnd)) === JSON.stringify({ startLine: 2, endLine: 3 }),
    JSON.stringify(lineRangeOf(text, spanStart, spanEnd)));

  // 整篇选中
  check('全选', JSON.stringify(lineRangeOf(text, 0, text.length)) === JSON.stringify({ startLine: 1, endLine: 4 }),
    JSON.stringify(lineRangeOf(text, 0, text.length)));

  // 行尾换行符计入下一行：选中 "line2\n"
  const withNl = lineRangeOf(text, 6, 12);
  check('选区含行尾换行 → 跨到下一行', withNl.endLine === 3, JSON.stringify(withNl));
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m存在失败\x1b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
