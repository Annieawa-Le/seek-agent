/**
 * patch 工具集成测试：走完整 add_patch / del_patch / replace_str 链路
 * 运行：pnpm tsx scripts/test-patch-integration.ts
 */
import * as fs from 'node:fs';
import { addPatch, delPatch } from '../src/tools/file-manipulation.js';
import { replaceStrTool } from '../src/tools/replace-str.js';

const target = 'scripts/__patch_target.ts';
fs.writeFileSync(target, [
  'export function alpha() {',
  '  const x = 1;',
  '  return x;',
  '}',
  '',
  'export function beta() {',
  '  return 2;',
  '}',
  '',
].join('\n'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}

try {
  // 1. add_patch：上下文匹配插入（pretext 带缩进微差：实际文件用 2 空格，这里故意给 4 空格）
  const addRes = await addPatch.execute({
    filePath: target,
    lineIndex: -1,
    Lines: ['', 'export function gamma() {', '  return 3;', '}'],
    pretext: ['    return 2;', '  }'],   // 缩进与文件不符 → 模糊匹配应命中
  } as any);
  const addText = String(addRes);
  check('add_patch 上下文插入成功', !addText.includes('错误'), addText);
  let content = fs.readFileSync(target, 'utf8');
  check('add_patch 插入位置正确（beta 之后）', content.includes('export function beta() {') && content.includes('export function gamma() {'),
    content);

  // 2. replace_str：字面量替换（唯一匹配默认成功）
  const modRes = await replaceStrTool.execute({
    filePath: target,
    search: '  const x = 1;',
    replace: '  const x = 42;',
  } as any);
  const modText = String(modRes);
  check('replace_str 替换成功', !modText.includes('错误'), modText);
  content = fs.readFileSync(target, 'utf8');
  check('replace_str 替换内容生效', content.includes('const x = 42;'), content);
  // 3. del_patch：上下文删除（删除 pretext 与 endtext 之间的 body，锚点无关——验证全局搜索）
  const delRes = await delPatch.execute({
    filePath: target,
    pretext: ['export function gamma() {'],
    endtext: ['}'],
  } as any);
  const delText = String(delRes);
  check('del_patch 上下文删除成功', !delText.includes('错误'), delText);
  content = fs.readFileSync(target, 'utf8');
  check('del_patch 删除生效（gamma body 已删）', content.includes('export function gamma() {') && !content.includes('return 3;'), content);

  // 4. 匹配失败应显式报错（不再静默回退）
  const badRes = await addPatch.execute({
    filePath: target,
    lineIndex: 5,
    Lines: ['// x'],
    pretext: ['完全不存在的内容'],
  } as any);
  const badText = String(badRes);
  check('匹配失败显式报错', badText.includes('上下文匹配失败'), badText);
  const badContent = fs.readFileSync(target, 'utf8');
  check('匹配失败未写入文件', !badContent.includes('// x'), badContent);
} finally {
  try { fs.unlinkSync(target); } catch { /* ignore */ }
}

console.log('\n==============================');
console.log('PASS ' + pass + ' / ' + (pass + fail));
if (fail > 0) process.exit(1);





