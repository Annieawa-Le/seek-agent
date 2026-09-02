/**
 * read_lines 尾部提示语义测试
 *
 * read_lines / readCertainLines：请求范围超出文件末尾时，不再补假空行，
 * 改为在结果开头提示「文件共 XX 行，已达文件末尾」。
 *
 * 运行：pnpm tsx scripts/test-read-modify-semantics.ts
 */
import * as fs from 'node:fs';
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
} finally {
  try { fs.unlinkSync(target); } catch { /* ignore */ }
}

console.log('\n==============================');
console.log('PASS ' + pass + ' / ' + (pass + fail));
if (fail > 0) process.exit(1);
