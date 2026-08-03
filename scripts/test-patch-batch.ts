/**
 * 并行 patch 批次暂存测试
 *
 * 场景：同一条 assistant 消息里对同一文件出现多个 patch（add_patch / del_patch /
 * modify_patch）时，自动静默进入暂存区，基于同一基准快照从后往前合并应用，
 * 避免逐个直接写盘导致的行号偏移。串行调用不受影响，直接写盘。
 *
 * 运行：pnpm tsx scripts/test-patch-batch.ts
 */
import * as fs from 'node:fs';
import { addPatch, delPatch, modifyPatch } from '../src/tools/file-manipulation.js';
import { patchBatch } from '../src/tools/patch-batch.js';
import { undoStack } from '../src/tools/patch-undo.js';

const target = 'scripts/__patch_batch_target.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}
function readLines(): string[] {
  return fs.readFileSync(target, 'utf8').split('\n').filter(l => l.length > 0);
}
function writeBase(n = 10): void {
  const lines = Array.from({ length: n }, (_, i) => `line${i + 1}`);
  fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');
}

try {
  // 1. 混合批次从后往前应用：add 前部 + modify 中部 + del 后部（全基于基准 10 行坐标）
  writeBase(10);
  const base = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8', 'line9', 'line10'];
  patchBatch.beginBatch(target, base, true, '\n');
  patchBatch.stage(target, { type: 'add', insertIndex: 3, lines: ['insertA'], description: '在第 3 行后插入' });
  patchBatch.stage(target, { type: 'modify', startLine: 6, endLine: 7, lines: ['mod6', 'mod7'], description: '修改行 6-7' });
  patchBatch.stage(target, { type: 'del', ranges: [[9, 10]], description: '删除行 9-10' });
  const r1 = await patchBatch.flushAll();
  check('1a flush 成功', r1.length === 1 && r1[0].ok === true, JSON.stringify(r1));
  const expect = ['line1', 'line2', 'line3', 'insertA', 'line4', 'line5', 'mod6', 'mod7', 'line8'];
  check('1b 从后往前结果正确', JSON.stringify(readLines()) === JSON.stringify(expect), JSON.stringify(readLines()));
  check('1c flush 后批次清空', patchBatch.activeCount === 0, String(patchBatch.activeCount));

  // 2. 末尾追加 add 与其他 patch 混用
  writeBase(5);
  patchBatch.beginBatch(target, ['line1', 'line2', 'line3', 'line4', 'line5'], true, '\n');
  patchBatch.stage(target, { type: 'add', insertIndex: 1, lines: ['X'], description: '第 1 行后' });
  patchBatch.stage(target, { type: 'add', insertIndex: -1, lines: ['tail'], description: '末尾追加' });
  await patchBatch.flushAll();
  const lines2 = readLines();
  check('2a 末尾追加 + 中间插入', lines2[1] === 'X' && lines2[lines2.length - 1] === 'tail', JSON.stringify(lines2));

  // 3. 多文件批次独立应用
  const target2 = 'scripts/__patch_batch_target2.ts';
  fs.writeFileSync(target2, 'a1\na2\na3\na4\n', 'utf8');
  writeBase(4);
  patchBatch.beginBatch(target, ['l1', 'l2', 'l3', 'l4'], true, '\n');
  patchBatch.beginBatch(target2, ['a1', 'a2', 'a3', 'a4'], true, '\n');
  patchBatch.stage(target, { type: 'modify', startLine: 2, endLine: 2, lines: ['l2mod'], description: 'm' });
  patchBatch.stage(target, { type: 'add', insertIndex: 0, lines: ['l0'], description: 'a' });
  patchBatch.stage(target2, { type: 'del', ranges: [[1, 1]], description: 'd' });
  await patchBatch.flushAll();
  const lf1 = readLines();
  const lf2 = fs.readFileSync(target2, 'utf8').split('\n').filter(l => l.length > 0);
  check('3a 文件1 独立应用', lf1[0] === 'l0' && lf1[2] === 'l2mod', JSON.stringify(lf1));
  check('3b 文件2 独立应用', lf2.length === 3 && lf2[0] === 'a2', JSON.stringify(lf2));
  fs.unlinkSync(target2);

  // 4. discardAll 放弃：文件保持原状（中断场景）
  writeBase(4);
  const before = fs.readFileSync(target, 'utf8');
  patchBatch.beginBatch(target, ['l1', 'l2', 'l3', 'l4'], true, '\n');
  patchBatch.stage(target, { type: 'del', ranges: [[2, 3]], description: 'd' });
  patchBatch.discardAll();
  check('4a discard 后文件未变', fs.readFileSync(target, 'utf8') === before, fs.readFileSync(target, 'utf8'));
  check('4b discard 后无活动批次', patchBatch.activeCount === 0, String(patchBatch.activeCount));

  // 5. flush 失败（行号越界）：文件保持原状，返回 ok:false
  writeBase(4);
  const before5 = fs.readFileSync(target, 'utf8');
  patchBatch.beginBatch(target, ['l1', 'l2', 'l3', 'l4'], true, '\n');
  patchBatch.stage(target, { type: 'del', ranges: [[99, 100]], description: '越界' });
  const r5 = await patchBatch.flushAll();
  check('5a 越界返回失败', r5.length === 1 && r5[0].ok === false && r5[0].message.includes('超出范围'), JSON.stringify(r5));
  check('5b 失败后文件保持原状', fs.readFileSync(target, 'utf8') === before5, fs.readFileSync(target, 'utf8'));

  // 6. 工具层批次模式：beginBatch 后 addPatch/modifyPatch/delPatch 返回"已暂存"且不写盘
  writeBase(4);
  patchBatch.beginBatch(target, ['l1', 'l2', 'l3', 'l4'], true, '\n');
  const r6a = await addPatch.execute({ filePath: target, lineIndex: 2, Lines: ['X6'] } as any);
  check('6a add 返回已暂存', String(r6a).includes('已暂存'), String(r6a));
  check('6b 暂存未写盘', !fs.readFileSync(target, 'utf8').includes('X6'), fs.readFileSync(target, 'utf8'));
  const r6b = await modifyPatch.execute({ filePath: target, startLine: 1, endLine: 1, replaceLines: ['m1'] } as any);
  check('6c modify 也已暂存', String(r6b).includes('已暂存'), String(r6b));
  const r6c = await delPatch.execute({ filePath: target, lineIndex: [[4, 4]] } as any);
  check('6d del 也已暂存', String(r6c).includes('已暂存'), String(r6c));
  await patchBatch.flushAll();
  const l6 = readLines();
  // 期望：del 删 l4 → modify 行 1 → add 在 l2 后插 X6 → m1, l2, X6, l3（4 行）
  check('6e flush 后合并应用', l6[0] === 'm1' && l6[2] === 'X6' && l6.length === 4, JSON.stringify(l6));

  // 7. flush 产生一条 'batch' undo 记录，undo_patch 整体回滚
  writeBase(3);
  patchBatch.beginBatch(target, ['l1', 'l2', 'l3'], true, '\n');
  patchBatch.stage(target, { type: 'modify', startLine: 1, endLine: 1, lines: ['new1'], description: 'm' });
  patchBatch.stage(target, { type: 'add', insertIndex: -1, lines: ['tail'], description: 'a' });
  await patchBatch.flushAll();
  check('7a 应用后内容', readLines().join('|') === 'new1|l2|l3|tail', readLines().join('|'));
  const undoRec = undoStack.peek();
  check('7b undo 记录类型为 batch', undoRec?.meta.type === 'batch', JSON.stringify(undoRec?.meta));
  await undoStack.undo();
  check('7c undo 后恢复基准', readLines().join('|') === 'l1|l2|l3', readLines().join('|'));

  // 8. 语法检查失败：flush 返回失败且不写盘
  const badTarget = 'scripts/__patch_batch_bad.ts';
  fs.writeFileSync(badTarget, 'const a = 1;\n', 'utf8');
  patchBatch.beginBatch(badTarget, ['const a = 1;'], true, '\n');
  patchBatch.stage(badTarget, { type: 'add', insertIndex: 1, lines: ['const b = ;'], description: '坏语法' });
  const r8 = await patchBatch.flushAll();
  check('8a 语法错误返回失败', r8.length === 1 && r8[0].ok === false, JSON.stringify(r8));
  check('8b 未写盘', fs.readFileSync(badTarget, 'utf8') === 'const a = 1;\n', fs.readFileSync(badTarget, 'utf8'));
  fs.unlinkSync(badTarget);

  // 9. 普通模式不受影响：无批次时 addPatch 直接写盘
  writeBase(2);
  patchBatch.discardAll();
  const r9 = await addPatch.execute({ filePath: target, lineIndex: 1, Lines: ['direct'] } as any);
  check('9a 普通模式直接写盘', !String(r9).includes('已暂存') && readLines()[1] === 'direct', String(r9));
  check('9b 普通模式无批次', patchBatch.activeCount === 0, String(patchBatch.activeCount));
} finally {
  try { fs.unlinkSync(target); } catch { /* ignore */ }
  patchBatch.discardAll();
}

console.log('\n==============================');
console.log('PASS ' + pass + ' / ' + (pass + fail));
if (fail > 0) process.exit(1);

