/**
 * patch-merge 单元测试：验证「多个 patch 合并成一份最终 patch」的各项语义。
 * 运行：pnpm tsx scripts/test-patch-merge.ts
 */
import {
  countHunkChanges,
  mergeFilePatches,
  parseHunk,
  toUnifiedPatch,
  type PatchLike,
} from '../electron/renderer/src/utils/patch-merge.ts';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `期望 ${e}，实际 ${a}`);
}

/** 按 generateSimpleDiff 的形态拼一份 hunk 文本：前文上下文 → 删除 → 新增 → 后文上下文 */
function diffOf(before: string[], removed: string[], added: string[], after: string[]): string {
  return [
    ...before.map(l => ` ${l}`),
    ...removed.map(l => `-${l}`),
    ...added.map(l => `+${l}`),
    ...after.map(l => ` ${l}`),
  ].join('\n');
}

function patch(id: string, timestamp: number, diff: string): PatchLike {
  return { id, timestamp, diff };
}

/* ── 场景 1：纯新增 ── */
console.log('\n[1] 纯新增');
{
  const base = [
    "import { a } from 'a';",
    '',
    'export function greet(name) {',
    "  console.log('hi', name);",
    '  return name;',
    '}',
    '',
    'const x = 1;',
    'const y = 2;',
    '',
    'export default greet;',
  ];
  const current = [...base.slice(0, 4), '  const extra = 42;', ...base.slice(4)];
  const r = mergeFilePatches([
    patch('p1', 1, diffOf([base[2], base[3]], [], ['  const extra = 42;'], [base[4], base[5], base[6]])),
  ], current);
  eq('落点区间', r.hunks.map(h => [h.start, h.end]), [[4, 5]]);
  eq('新增行', r.hunks[0]?.added, ['  const extra = 42;']);
  eq('删除行为空', r.hunks[0]?.removed, []);
  eq('全部定位成功', [r.located, r.total], [1, 1]);
}

/* ── 场景 2：纯删除（落点为零宽区间） ── */
console.log('\n[2] 纯删除');
{
  const base = [
    'import { a }', '', 'export function greet() {', '  return 1;', '}', '', 'const x = 1;', 'const y = 2;', '', 'export default greet;',
  ];
  const current = base.filter((_, i) => i !== 6);
  const r = mergeFilePatches([
    patch('p1', 1, diffOf([base[4], base[5]], [base[6]], [], [base[7], base[8], base[9]])),
  ], current);
  // 删掉一行后没有新增行，落点落在「前文」与「后文」之间的零宽间隙上
  eq('落点区间', r.hunks.map(h => [h.start, h.end]), [[6, 6]]);

  eq('删除行', r.hunks[0]?.removed, ['const x = 1;']);
  eq('新增行为空', r.hunks[0]?.added, []);
}

/* ── 场景 3：单行修改 ── */
console.log('\n[3] 修改');
{
  const base = ['a', '', 'function f() {', '  old();', '  tail();', '}', ''];
  const current = base.map((l, i) => (i === 3 ? '  new();' : l));
  const r = mergeFilePatches([
    patch('p1', 5, diffOf([base[1], base[2]], [base[3]], ['  new();'], [base[4], base[5], base[6]])),
  ], current);
  eq('落点区间', r.hunks.map(h => [h.start, h.end]), [[3, 4]]);
  eq('删除/新增', [r.hunks[0]?.removed, r.hunks[0]?.added], [['  old();'], ['  new();']]);
}

/* ── 场景 4：同一行被连改两次 —— 旧改动定位失败被跳过，只留最终形态 ── */
console.log('\n[4] 同区域覆盖（历史 patch 无法定位时优雅跳过）');
{
  const current = ['const v = 2;', 'tail'];
  const r = mergeFilePatches([
    patch('p1', 1, diffOf([], ['const v = 0;'], ['const v = 1;'], ['tail'])),
    patch('p2', 2, diffOf([], ['const v = 1;'], ['const v = 2;'], ['tail'])),
  ], current);
  eq('只剩一段', r.hunks.length, 1);
  eq('删除行取可定位的那次', r.hunks[0]?.removed, ['const v = 1;']);
  eq('新增行 = 当前内容', r.hunks[0]?.added, ['const v = 2;']);
  eq('统计', [r.located, r.total], [1, 2]);
}

/* ── 场景 5：两处互不相干的修改 → 两个 hunk ── */
console.log('\n[5] 多处独立修改');
{
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const current = ['a', 'b', 'C', 'd', 'e', 'f', 'G', 'h'];
  const r = mergeFilePatches([
    patch('p1', 1, diffOf(['a', 'b'], ['c'], ['C'], ['d', 'e', 'f'])),
    patch('p2', 2, diffOf(['e', 'f'], ['g'], ['G'], ['h'])),
  ], current);
  eq('两个落点', r.hunks.map(h => [h.start, h.end]), [[2, 3], [6, 7]]);
  eq('各自删除行', r.hunks.map(h => h.removed), [['c'], ['g']]);
}

/* ── 场景 6：相邻的两处改动合并成一段，删除行按时间拼接 ── */
console.log('\n[6] 相接区间合并');
{
  const current = ['a', 'b', 'C', 'D', 'e'];
  const r = mergeFilePatches([
    patch('p1', 1, diffOf(['a', 'b'], ['c'], ['C'], ['d', 'e'])),
    patch('p2', 2, diffOf(['b', 'C'], ['d'], ['D'], ['e'])),
  ], current);
  eq('合并成一段', r.hunks.length, 1);
  eq('落点跨越两行', [r.hunks[0]?.start, r.hunks[0]?.end], [2, 4]);
  eq('删除行按时间先后拼接', r.hunks[0]?.removed, ['c', 'd']);
  eq('新增行从当前内容切片', r.hunks[0]?.added, ['C', 'D']);
  eq('patchIds 去重', r.hunks[0]?.patchIds, ['p1', 'p2']);
}

/* ── 场景 7：脏数据不应导致误判 ── */
console.log('\n[7] 异形/空 diff 直接跳过');
{
  eq('带 @@ 头', parseHunk('@@ -1,3 +1,4 @@\n a\n-b\n+c'), null);
  eq('空文本', parseHunk(''), null);
  eq('只有上下文', parseHunk(' a\n b'), null);
  const r = mergeFilePatches([patch('bad', 1, '@@ -1 +1 @@\n-x\n+y')], ['y']);
  eq('空结果', [r.hunks.length, r.located, r.total], [0, 0, 1]);
}

/* ── 场景 8：还原成 unified patch ── */
console.log('\n[8] toUnifiedPatch 还原');
{
  const lines = ['a', 'b', 'C', 'D', 'e'];
  const r = mergeFilePatches([
    patch('p1', 1, diffOf(['a', 'b'], ['c'], ['C', 'D'], ['e'])),
  ], lines);
  eq('unified 文本', toUnifiedPatch(lines, r.hunks, 1), [' b', '-c', '+C', '+D', ' e'].join('\n'));
  eq('空 hunks 返回空串', toUnifiedPatch(lines, [], 1), '');
}

/* ── 场景 9：统计 ── */
console.log('\n[9] 变更统计');
{
  const lines = ['a', 'b', 'C', 'D', 'e'];
  const r = mergeFilePatches([patch('p1', 1, diffOf(['a', 'b'], ['c'], ['C', 'D'], ['e']))], lines);
  eq('+2 / -1', countHunkChanges(r.hunks), { added: 2, removed: 1 });
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}结果：${pass} 通过 / ${fail} 失败\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);

