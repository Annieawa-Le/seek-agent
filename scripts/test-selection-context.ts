/**
 * 内联差异视图「选区 → 代码上下文」的纯逻辑测试。
 *
 * 覆盖 rangeToContext：审阅模式下从 DOM 选区反查真实文件行号的核心规则，
 * 特别是「幽灵删除行不参与行号、也不进入代码块」这条约定。
 *
 * 运行：pnpm tsx scripts/test-selection-context.ts
 */
import { rangeToContext } from '../electron/renderer/src/utils/selection-context.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * 模拟一份文件：内联视图在第 2 行后插了 2 条幽灵删除行，
 * 真实行号 1..5 与内容一致。
 */
const FILE = 'D:/proj/src/a.ts';
const lines = [
  'const a = 1;',      // 1
  'const b = 2;',      // 2
  'function hello() {',// 3
  '  return a + b;',   // 4
  '}',                 // 5
];

console.log('\n[1] 两端都有效：正常区间');
{
  const r = rangeToContext(lines, FILE, 2, 4);
  check('行号正确', r?.startLine === 2 && r?.endLine === 4, JSON.stringify(r && [r.startLine, r.endLine]));
  check('正文按行切片', r?.code === 'const b = 2;\nfunction hello() {\n  return a + b;', JSON.stringify(r?.code));
  check('带出文件路径', r?.filePath === FILE);
}

console.log('\n[2] 单行选区');
{
  const r = rangeToContext(lines, FILE, 3, 3);
  check('起止同行', r?.startLine === 3 && r?.endLine === 3);
  check('正文只有一行', r?.code === 'function hello() {', JSON.stringify(r?.code));
}

console.log('\n[3] 幽灵删除行的处理（核心约定）');
{
  // 选区一端落在幽灵行上（无 data-line → 传 null），应被有效端兜底
  const a = rangeToContext(lines, FILE, null, 3);
  check('起点在幽灵行 → 用终点兜底', a?.startLine === 3 && a?.endLine === 3, JSON.stringify(a && [a.startLine, a.endLine]));
  check('幽灵行不进入代码块', a?.code === 'function hello() {', JSON.stringify(a?.code));

  const b = rangeToContext(lines, FILE, 2, null);
  check('终点在幽灵行 → 用起点兜底', b?.startLine === 2 && b?.endLine === 2, JSON.stringify(b && [b.startLine, b.endLine]));

  const c = rangeToContext(lines, FILE, null, null);
  check('整段都在幽灵行 → 不给上下文', c === null, JSON.stringify(c));
}

console.log('\n[4] 反向选区（从下往上拖）');
{
  const r = rangeToContext(lines, FILE, 4, 2);
  check('行号归一为小→大', r?.startLine === 2 && r?.endLine === 4, JSON.stringify(r && [r.startLine, r.endLine]));
  check('正文顺序仍是文件顺序', r?.code.startsWith('const b = 2;'), JSON.stringify(r?.code?.slice(0, 20)));
}

console.log('\n[5] 越界与非法行号');
{
  check('起点超尾 → null', rangeToContext(lines, FILE, 6, 8) === null);
  check('终点越界 → null', rangeToContext(lines, FILE, 1, 99) === null);
  check('0 行 → null', rangeToContext(lines, FILE, 0, 2) === null);
  check('负数 → null', rangeToContext(lines, FILE, -3, 2) === null);
}

console.log('\n[6] 空白内容不收');
{
  const blanks = ['const a = 1;', '   ', '\t', 'const b = 2;'];
  check('纯空白区间 → null', rangeToContext(blanks, FILE, 2, 3) === null);
  check('含内容的区间 → 保留', rangeToContext(blanks, FILE, 1, 4)?.code.includes('const a') === true);
}

console.log('\n[7] 单行文件与边界');
{
  const one = ['only line'];
  const r = rangeToContext(one, FILE, 1, 1);
  check('单行文件能选中', r?.code === 'only line', JSON.stringify(r?.code));
  check('单行文件越界 → null', rangeToContext(one, FILE, 2, 2) === null);
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m存在失败\x1b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
