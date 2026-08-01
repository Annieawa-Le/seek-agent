/**
 * add_patch lineIndex 新语义测试（在第 N 行之后插入）
 * 运行：pnpm tsx scripts/test-add-patch-semantics.ts
 *
 * 覆盖：
 *  1. lineIndex=N → 在第 N 行之后插入
 *  2. lineIndex=0 → 文件开头插入
 *  3. lineIndex=-1 → 末尾追加
 *  4. lineIndex 越界报错
 *  5. pretext/endtext 上下文定位不受影响
 */
import * as fs from 'node:fs';
import { addPatch } from '../src/tools/file-manipulation.js';

const target = 'scripts/__add_patch_target.ts';
const BASE = ['export function alpha() {', '  return 1;', '}', ''];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}
function readLines(): string[] {
  return fs.readFileSync(target, 'utf8').split('\n').filter(l => l.length > 0);
}

try {
  // 1. lineIndex=N → 第 N 行之后插入
  fs.writeFileSync(target, BASE.join('\n'), 'utf8');
  await addPatch.execute({ filePath: target, lineIndex: 2, Lines: ['  const x = 10;'] } as any);
  let lines = readLines();
  check('1a 第 2 行后插入', lines[2] === '  const x = 10;' && lines[1] === '  return 1;' && lines[3] === '}', JSON.stringify(lines));

  // 2. lineIndex=0 → 文件开头
  fs.writeFileSync(target, BASE.join('\n'), 'utf8');
  await addPatch.execute({ filePath: target, lineIndex: 0, Lines: ['// header'] } as any);
  lines = readLines();
  check('2a 开头插入', lines[0] === '// header' && lines[1] === 'export function alpha() {', JSON.stringify(lines));

  // 3. lineIndex=-1 → 末尾追加
  fs.writeFileSync(target, BASE.join('\n'), 'utf8');
  const r3 = await addPatch.execute({ filePath: target, lineIndex: -1, Lines: ['export function beta() {', '  return 2;', '}'] } as any);
  lines = readLines();
  check('3a 末尾追加', lines[lines.length - 1] === '}' && lines[lines.length - 3] === 'export function beta() {', JSON.stringify(lines));
  check('3b 描述为末尾', String(r3).includes('末尾'), String(r3).split('\n')[0]);

  // 4. 越界报错
  fs.writeFileSync(target, BASE.join('\n'), 'utf8');
  const r4 = await addPatch.execute({ filePath: target, lineIndex: 99, Lines: ['// x'] } as any);
  check('4a 越界显式报错', String(r4).includes('超出范围'), String(r4));
  const c4 = fs.readFileSync(target, 'utf8');
  check('4b 越界未写入', !c4.includes('// x'), c4);

  // 5. 上下文定位（pretext 后插入）不受行号语义影响
  fs.writeFileSync(target, BASE.join('\n'), 'utf8');
  const r5 = await addPatch.execute({
    filePath: target, lineIndex: 1, Lines: ['  // inserted'],
    pretext: ['export function alpha() {'],
  } as any);
  lines = readLines();
  check('5a pretext 后插入', lines[1] === '  // inserted' && lines[2] === '  return 1;', JSON.stringify(lines));

  // 6. 空文件 lineIndex=0 开头 / -1 末尾等效
  fs.writeFileSync(target, '', 'utf8');
  await addPatch.execute({ filePath: target, lineIndex: 0, Lines: ['const a = 1;'] } as any);
  lines = readLines();
  check('6a 空文件 lineIndex=0 可插入', lines.length === 1 && lines[0] === 'const a = 1;', JSON.stringify(lines));
} finally {
  try { fs.unlinkSync(target); } catch { /* ignore */ }
}

console.log('\n==============================');
console.log('PASS ' + pass + ' / ' + (pass + fail));
if (fail > 0) process.exit(1);
