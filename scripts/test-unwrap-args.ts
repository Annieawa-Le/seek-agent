/**
 * test-unwrap-args.ts — 包装参数解包兼容测试
 *
 * 验证：模型偶尔把工具参数包进 _raw / input / args 等包装键时，
 * unwrapToolArgs 能解包为扁平参数，让工具调用正常执行（而非报"文件路径为空"）。
 */
import { unwrapToolArgs } from '../src/tools/unwrap-args';
import { addPatch } from '../src/tools/file-manipulation';
import fs from 'node:fs';
import path from 'node:path';

const TMP_DIR = path.join('scripts', '__unwrap-tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

// 模拟 wrapTool 的 execute 包装（与 src/tools/index.ts wrapTool 同逻辑）
const wrapped = (t: any) => ({
  ...t,
  execute: async (args: any, ctx?: any) => t.execute(unwrapToolArgs(args), ctx),
});
const addPatchWrapped = wrapped(addPatch);

// ── 1. unwrapToolArgs 纯函数 ──
check('1a _raw 解包', JSON.stringify(unwrapToolArgs({ _raw: { filePath: 'a.ts', startLine: 3 } })) === JSON.stringify({ filePath: 'a.ts', startLine: 3 }));
check('1b input 解包', JSON.stringify(unwrapToolArgs({ input: { filePath: 'a.ts' } })) === JSON.stringify({ filePath: 'a.ts' }));
check('1c args 解包', JSON.stringify(unwrapToolArgs({ args: { filePath: 'a.ts' } })) === JSON.stringify({ filePath: 'a.ts' }));
check('1d 扁平参数不变', JSON.stringify(unwrapToolArgs({ filePath: 'a.ts', startLine: 3 })) === JSON.stringify({ filePath: 'a.ts', startLine: 3 }));
check('1e 混合（顶层有值）不解包', JSON.stringify(unwrapToolArgs({ _raw: { filePath: 'a.ts' }, filePath: 'b.ts' })) === JSON.stringify({ _raw: { filePath: 'a.ts' }, filePath: 'b.ts' }));
check('1f 字符串值不解包', JSON.stringify(unwrapToolArgs({ input: 'text' })) === JSON.stringify({ input: 'text' }));
check('1g null 不变', unwrapToolArgs(null) === null);
check('1h undefined 不变', unwrapToolArgs(undefined) === undefined);
check('1i 数组不变', JSON.stringify(unwrapToolArgs([1, 2])) === JSON.stringify([1, 2]));
check('1j 空对象不变', JSON.stringify(unwrapToolArgs({})) === JSON.stringify({}));
check('1k 包装键值含 undefined 顶层字段不误解包', JSON.stringify(unwrapToolArgs({ _raw: { filePath: 'a.ts' }, startLine: undefined })) === JSON.stringify({ filePath: 'a.ts' }));

// ── 2. 集成：wrapTool 包装后 _raw 包装调用正常执行 ──
(async () => {
  const target = path.join(TMP_DIR, `unwrap-test-${Date.now()}.ts`);
  fs.writeFileSync(target, 'const a = 1;\nconst b = 2;\n', 'utf8');
  try {
    // _raw 包装调用
    const res = await addPatchWrapped.execute({
      _raw: {
        filePath: target,
        lineIndex: 2,
        Lines: ['const c = 3;'],
      },
    });
    const text = String(res);
    check('2a _raw 包装调用成功执行', text.includes('[ADD]'), text.slice(0, 120));
    const content = fs.readFileSync(target, 'utf8');
    check('2b 内容已按扁平参数写入', content.includes('const c = 3;'), content);

    // input 包装调用
    const res2 = await addPatchWrapped.execute({
      input: {
        filePath: target,
        lineIndex: 0,
        Lines: ['const pre = 0;'],
      },
    });
    check('2c input 包装调用成功执行', String(res2).includes('[ADD]'), String(res2).slice(0, 120));
    const content2 = fs.readFileSync(target, 'utf8');
    check('2d input 内容正确', content2.includes('const pre = 0;'), content2);

    // args 包装调用
    const res3 = await addPatchWrapped.execute({
      args: {
        filePath: target,
        lineIndex: -1,
        Lines: ['// tail'],
      },
    });
    check('2e args 包装调用成功执行', String(res3).includes('[ADD]'), String(res3).slice(0, 120));
    const content3 = fs.readFileSync(target, 'utf8');
    check('2f args 内容正确', content3.includes('// tail'), content3);
  } finally {
    fs.rmSync(target, { force: true });
  }

  // ── 3. 混合参数：顶层优先 ──
  const target2 = path.join(TMP_DIR, `unwrap-test2-${Date.now()}.ts`);
  fs.writeFileSync(target2, 'const a = 1;\n', 'utf8');
  try {
    const res = await addPatchWrapped.execute({
      _raw: { filePath: 'nonexistent.ts' }, // 包装键是错的
      filePath: target2,                    // 顶层才是对的
      lineIndex: 1,
      Lines: ['const ok = true;'],
    });
    check('3a 混合参数用顶层（文件正常写入）', String(res).includes('[ADD]'), String(res).slice(0, 120));
    const content = fs.readFileSync(target2, 'utf8');
    check('3b 内容正确', content.includes('const ok = true;'), content);
  } finally {
    fs.rmSync(target2, { force: true });
  }

  // ── 4. 扁平参数直接执行（回归，确认 wrapTool 包装不改变正常调用） ──
  const target3 = path.join(TMP_DIR, `unwrap-test3-${Date.now()}.ts`);
  fs.writeFileSync(target3, 'const a = 1;\n', 'utf8');
  try {
    const res = await addPatchWrapped.execute({
      filePath: target3,
      lineIndex: 1,
      Lines: ['const b = 2;'],
    });
    check('4a 扁平参数正常执行', String(res).includes('[ADD]'), String(res).slice(0, 120));
    const content = fs.readFileSync(target3, 'utf8');
    check('4b 扁平内容正确', content.includes('const b = 2;'), content);
  } finally {
    fs.rmSync(target3, { force: true });
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();



