/**
 * read_lines 尾部提示 + modify_patch 包含 pretext/endtext 语义测试
 *
 * 1. read_lines / readCertainLines：请求范围超出文件末尾时，不再补假空行，
 *    改为在结果开头提示「文件共 XX 行，已达文件末尾」。
 * 2. modify_patch：提供 pretext/endtext 时，替换范围直接包含 pretext/endtext 本身
 *    （不再依赖「replaceLines 恰好包含上下文」的智能检测）。
 *
 * 运行：pnpm tsx scripts/test-read-modify-semantics.ts
 */
import * as fs from 'node:fs';
import { modifyPatch } from '../src/tools/file-manipulation.js';
import { readNumline, readCertainLines } from '../src/tools/read-file.js';

const target = 'scripts/__read_modify_target.txt';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}

try {
  // ============ 1. read_lines（readNumline）尾部行为 ============
  fs.writeFileSync(target, ['a', 'b', 'c', 'd', 'e'].join('\n'), 'utf8'); // 5 行，无尾换行

  const r1 = String(await readNumline.execute({ filePath: target, startLine: 1, endLine: 8 } as any));
  check('read_lines 超末尾开头提示', r1.startsWith('⚠️ 文件共 5 行，已达文件末尾'), r1);
  check('read_lines 不补假空行', !r1.includes('6: ') && !r1.includes('7: ') && !r1.includes('8: '), r1);
  check('read_lines 返回全部实际行', r1.includes('   1: a') && r1.includes('   5: e'), r1);

  const r2 = String(await readNumline.execute({ filePath: target, startLine: 1, endLine: 5 } as any));
  check('read_lines 恰好到末尾无提示', !r2.includes('已达文件末尾') && r2.includes('   5: e'), r2);

  const r3 = String(await readNumline.execute({ filePath: target, startLine: 4, endLine: 8 } as any));
  check('read_lines 中段越界只返回实际行', r3.includes('文件共 5 行') && r3.includes('   4: d') && r3.includes('   5: e') && !r3.includes('   6: '), r3);

  const r4 = String(await readNumline.execute({ filePath: target, startLine: 6, endLine: 8 } as any));
  check('read_lines 完全越界只有提示', r4.includes('文件共 5 行') && !r4.includes('   6:'), r4);

  // 尾部换行文件：'a\nb\n' → 实际 2 内容行
  fs.writeFileSync(target, 'a\nb\n', 'utf8');
  const r5 = String(await readNumline.execute({ filePath: target, startLine: 1, endLine: 3 } as any));
  check('read_lines 尾换行文件行数正确(2)', r5.includes('文件共 2 行') && r5.includes('   1: a') && r5.includes('   2: b') && !r5.includes('   3: '), r5);

  // readCertainLines（不带行号版本）
  fs.writeFileSync(target, ['a', 'b', 'c'].join('\n'), 'utf8');
  const r6 = String(await readCertainLines.execute({ filePath: target, startLine: 1, endLine: 10 } as any));
  check('readCertainLines 超末尾提示+不补空行', r6.startsWith('⚠️ 文件共 3 行') && r6.trim().split('\n').length === 4 && !r6.includes('d'), r6);

  // ============ 2. modify_patch 包含 pretext/endtext ============
  const alpha = ['export function alpha() {', '  const x = 1;', '  return x;', '}'];

  // 场景 A：replaceLines 完整新函数（含边界行），整段替换成功 + 提示包含上下文
  fs.writeFileSync(target, alpha.join('\n') + '\n', 'utf8');
  const ma = await modifyPatch.execute({
    filePath: target, startLine: 1, endLine: 4,
    replaceLines: ['export function alpha() {', '  const x = 42;', '  return x;', '}'],
    pretext: ['export function alpha() {'], endtext: ['}'],
  } as any);
  let content = fs.readFileSync(target, 'utf8');
  check('modify A 整段替换成功', String(ma).includes('包含 pretext/endtext') && content.includes('const x = 42;') && !content.includes('const x = 1;'), content);

  // 场景 B：replaceLines 不含 pretext/endtext → 仍整段替换（旧行为只换中间会坏）
  fs.writeFileSync(target, alpha.join('\n') + '\n', 'utf8');
  const mb = await modifyPatch.execute({
    filePath: target, startLine: 1, endLine: 4,
    replaceLines: ['export function beta() {', '  const y = 2;', '  return y;', '}'],
    pretext: ['export function alpha() {'], endtext: ['}'],
  } as any);
  content = fs.readFileSync(target, 'utf8');
  const lines = content.trim().split('\n');
  check('modify B 替换范围包含 pretext/endtext 整段', lines.length === 4 && lines[0] === 'export function beta() {' && lines[3] === '}' && !content.includes('alpha'), content);

  // 场景 C：仅 pretext → 替换 pretext 自身
  fs.writeFileSync(target, ['a', 'b', 'c'].join('\n'), 'utf8');
  const mc = await modifyPatch.execute({
    filePath: target, startLine: 2, endLine: 2,
    replaceLines: ['B'],
    pretext: ['b'],
  } as any);
  content = fs.readFileSync(target, 'utf8');
  check('modify C 仅 pretext 替换自身', content === 'a\nB\nc', content);

  // 场景 D：仅 endtext → 替换 endtext 前一行到 endtext 本身
  fs.writeFileSync(target, ['a', 'b', 'c'].join('\n'), 'utf8');
  const md = await modifyPatch.execute({
    filePath: target, startLine: 2, endLine: 3,
    replaceLines: ['B', 'C'],
    endtext: ['c'],
  } as any);
  content = fs.readFileSync(target, 'utf8');
  check('modify D 仅 endtext 替换到自身', content === 'a\nB\nC', content);

  // 场景 E：test-patch-integration 回归场景（replaceLines 含 pretext/endtext）
  fs.writeFileSync(target, alpha.join('\n') + '\n', 'utf8');
  const me = await modifyPatch.execute({
    filePath: target, startLine: 1, endLine: 1,
    replaceLines: ['export function alpha() {', '  const x = 42;', '  return x;', '}'],
    pretext: ['export function alpha() {'], endtext: ['}'],
  } as any);
  content = fs.readFileSync(target, 'utf8');
  check('modify E 集成回归', content.includes('const x = 42;') && content.trim().split('\n').length === 4, content);

  // 场景 F：模糊匹配（pretext 带缩进微差）+ 包含上下文
  fs.writeFileSync(target, [
    'export function alpha() {',
    '  const x = 1;',
    '  return x;',
    '}',
    '',
    'export function beta() {',
    '  return 2;',
    '}',
  ].join('\n'), 'utf8');
  const mf = await modifyPatch.execute({
    filePath: target, startLine: 6, endLine: 6,
    replaceLines: ['export function beta() {', '  return 22;', '}'],
    pretext: ['    export function beta() {'],   // 4 空格缩进差 → 模糊匹配第 6 行
    endtext: ['  }'],
  } as any);
  content = fs.readFileSync(target, 'utf8');
  check('modify F 模糊匹配+包含上下文', String(mf).includes('包含 pretext/endtext') && content.includes('return 22;') && !content.includes('return 2;') && content.includes('const x = 1;'), content);
} finally {
  try { fs.unlinkSync(target); } catch { /* ignore */ }
}

console.log('\n==============================');
console.log('PASS ' + pass + ' / ' + (pass + fail));
if (fail > 0) process.exit(1);


