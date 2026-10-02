/**
 * patch-revert 单元测试：验证按 unified diff 逆向还原文件内容的正确性。
 *
 * 这是审查面板「回退」的核心：.diff 里没有存改动前的完整内容，
 * 只能靠「上下文 + 删除/新增行」倒推。锚点从强到弱逐级退化，
 * 且对不上时宁可失败也不能写错位置。
 *
 * 运行：pnpm tsx scripts/test-patch-revert.ts
 */
import { parseUnifiedDiff, revertContent, RevertError } from '../electron/patch-revert.js';
import { generateSimpleDiff } from '../src/tools/patch-diff.ts';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

const join = (lines: string[]) => lines.join('\n');

/** 走一遍真实链路：generateSimpleDiff 生成 → revertContent 还原 */
function roundTrip(oldLines: string[], newLines: string[]): { diff: string; back: string } {
  const diff = generateSimpleDiff(oldLines, newLines);
  return { diff, back: revertContent(join(newLines), diff) };
}

/* ── 1. 与真实 diff 生成器闭环 ── */
console.log('\n[1] 与 generateSimpleDiff 闭环（还原结果必须等于改动前内容）');
{
  const cases: Array<{ name: string; old: string[]; now: string[] }> = [
    {
      name: '纯新增',
      old: ['a', 'b', 'c', 'd', 'e'],
      now: ['a', 'b', 'NEW', 'c', 'd', 'e'],
    },
    {
      name: '纯删除',
      old: ['a', 'b', 'GONE', 'c', 'd', 'e'],
      now: ['a', 'b', 'c', 'd', 'e'],
    },
    {
      name: '行内改写',
      old: ['import a;', '', 'const x = 1;', 'export default x;'],
      now: ['import a;', '', 'const x = 2;', 'export default x;'],
    },
    {
      name: '多行块替换',
      old: ['head', 'A', 'B', 'C', 'tail', 'more'],
      now: ['head', 'X', 'Y', 'tail', 'more'],
    },
    {
      name: '文件末尾追加',
      old: ['a', 'b', 'c'],
      now: ['a', 'b', 'c', 'd', 'e'],
    },
    {
      name: '整段清空（只剩首行）',
      old: ['keep', 'x', 'y', 'z'],
      now: ['keep'],
    },
    {
      name: '中文与缩进',
      old: ['  const 名称 = 1;', '  return 名称;', '}'],
      now: ['  const 名称 = 42;', '  return 名称;', '}'],
    },
  ];

  for (const c of cases) {
    const { diff, back } = roundTrip(c.old, c.now);
    check(`${c.name}：还原 === 改动前`, back === join(c.old), `\n    期望 ${JSON.stringify(join(c.old))}\n    实际 ${JSON.stringify(back)}`);
  }
}

/* ── 2. 无改动时 diff 为空 ── */
console.log('\n[2] 边界');
{
  check('空 diff 抛 badDiff', (() => {
    try { revertContent('abc', ''); return false; } catch (e) { return e instanceof RevertError && e.code === 'badDiff'; }
  })());

  check('含 @@ 头的异形结构抛 badDiff', (() => {
    try { revertContent('a\nb', '@@ -1,2 +1,2 @@\n-a\n+b'); return false; }
    catch (e) { return e instanceof RevertError && e.code === 'badDiff'; }
  })());

  check('解析结果四段结构正确', (() => {
    const p = parseUnifiedDiff(' pre1\n pre2\n-old\n+new\n post1');
    return JSON.stringify(p) === JSON.stringify({ before: ['pre1', 'pre2'], removed: ['old'], added: ['new'], after: ['post1'] });
  })());
}

/* ── 3. 定位不上时必须失败，绝不乱写 ── */
console.log('\n[3] 定位失败保护（宁可不改，也不能改错位置）');
{
  // 新增行在文件中根本不存在（比如文件已被外部程序改过）
  const diff = [' ctx-before', '-old', '+a-line-that-no-longer-exists', ' ctx-after'].join('\n');
  check('新增行不存在 → 抛 notFound', (() => {
    try { revertContent('completely\ndifferent\ncontent', diff); return false; }
    catch (e) { return e instanceof RevertError && e.code === 'notFound'; }
  })());

  // 前后文对不上：added 能匹配到，但 before/after 锚点不成立（疑似匹配到别处）
  const ambiguous = [' unique-before', '-old', '+dup', ' unique-after'].join('\n');
  check('仅 added 命中但前后文不匹配 → 抛 notFound', (() => {
    try { revertContent('other\ndup\nother', ambiguous); return false; }
    catch (e) { return e instanceof RevertError && e.code === 'notFound'; }
  })());
}

/* ── 4. 重复内容下的定位（锚点逐级退化） ── */
console.log('\n[4] 重复行场景');
{
  // 上下文构造：改动前 = dup dup SEP CHANGED dup dup
  //            改动后 = dup dup SEP changed dup dup
  // 除 SEP 外的行高度重复，只有上下文能把落点钉准。
  const oldLines = ['dup', 'dup', 'SEP', 'CHANGED', 'dup', 'dup'];
  const newLines = ['dup', 'dup', 'SEP', 'changed', 'dup', 'dup'];

  const diffFull = generateSimpleDiff(oldLines, newLines);
  const backFull = revertContent(join(newLines), diffFull);
  check('重复行 + 强上下文：能定位并还原', backFull === join(oldLines), `\n    diff=${JSON.stringify(diffFull)}\n    期望 ${JSON.stringify(join(oldLines))}\n    实际 ${JSON.stringify(backFull)}`);

  // 退化一：去掉后文上下文，靠「前文 + 新增」定位（SEP 紧接 CHANGED，唯一）
  const diffNoAfter = [' dup', ' dup', ' SEP', '-CHANGED', '+changed'].join('\n');
  const back2 = revertContent(join(newLines), diffNoAfter);
  check('缺后文上下文：退化为「前文 + 新增」定位', back2 === join(oldLines), JSON.stringify(back2));

  // 退化二：完全没有上下文，只剩「删除 + 新增」，只能靠新增行定位
  const diffOnlyAdded = ['-CHANGED', '+changed'].join('\n');
  const back3 = revertContent(join(newLines), diffOnlyAdded);
  check('无任何上下文：退化为只用新增行定位', back3 === join(oldLines), JSON.stringify(back3));

  // 最弱锚点 + 上下文对不上：必须拒绝，不能落到别处
  const diffStale = [' ctx-not-in-file', '-CHANGED', '+changed', ' ctx-not-in-file-either'].join('\n');
  check('上下文与内容不符 → 拒绝（不落到别处）', (() => {
    try { revertContent(join(newLines), diffStale); return false; }
    catch (e) { return e instanceof RevertError && e.code === 'notFound'; }
  })());
}

/* ── 5. 回退后的内容可再次参与合并/解析（不产生畸形结构） ── */
console.log('\n[5] 幂等性：还原结果再次走 diff 生成仍自洽');
{
  const oldLines = ['a', 'b', 'c', 'd'];
  const newLines = ['a', 'B2', 'c', 'd'];
  const { diff, back } = roundTrip(oldLines, newLines);
  const again = generateSimpleDiff(back.split('\n'), oldLines);
  // 还原后内容 === 原始内容，故再 diff 应当无变化
  check('还原后与原文一致 → 再 diff 为空', again === '', JSON.stringify(again));
  check('原 diff 非空（确保用例有效）', diff !== '');
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m存在失败\x1b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
