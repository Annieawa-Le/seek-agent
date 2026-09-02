/**
 * test-replace-str.ts — replace_str 快速替换工具测试（dsh str_replace 标准语义）
 *
 * 覆盖：默认大小写敏感、默认唯一匹配（多处拒绝）、replaceAll 全量开关、findMatches 行号。
 */
import { replaceText, findMatches } from '../src/tools/replace-str';
import { replaceStrTool } from '../src/tools/replace-str';
import { undoPatch } from '../src/tools/file-manipulation';
import fs from 'node:fs';
import path from 'node:path';

const TMP_DIR = path.join('scripts', '__replace-tmp');
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

// ── 1. replaceText / findMatches 纯函数 ──
// 1a 默认大小写敏感（字面量精确匹配）
check('1a 默认大小写敏感', replaceText('Foo foo FOO', 'foo', 'bar').text === 'Foo bar FOO');
// 1b 显式大小写不敏感（非全量只替换第一处）
check('1b 大小写不敏感', replaceText('Foo foo FOO', 'foo', 'bar', { caseSensitive: false }).text === 'bar foo FOO');
// 1b2 大小写不敏感 + 全量
check('1b2 大小写不敏感全量', replaceText('Foo foo FOO', 'foo', 'bar', { caseSensitive: false, replaceAll: true }).text === 'bar bar bar');
// 1c 计数正确
check('1c 计数正确', replaceText('Foo foo FOO', 'foo', 'bar', { caseSensitive: true, replaceAll: true }).count === 1);
// 1d 默认非全量：多匹配只替换第一处（纯函数层面）
check('1d 默认只替换第一处', replaceText('a a a', 'a', 'b').text === 'b a a');
// 1e replaceAll=true 全量替换
check('1e 全量替换', replaceText('a a a', 'a', 'b', { replaceAll: true }).text === 'b b b');
// 1f 整词匹配（全量）
check('1f 整词匹配', replaceText('foo foobar bar foo', 'foo', 'X', { wholeWord: true, replaceAll: true }).text === 'X foobar bar X');
// 1g 整词 + 大小写敏感
check('1g 整词+敏感', replaceText('Foo foo', 'foo', 'X', { wholeWord: true, caseSensitive: true }).text === 'Foo X');
// 1h 删除匹配（全量）
check('1h 删除匹配', replaceText('abc def abc', 'abc', '', { replaceAll: true }).text === ' def ');
// 1i 空 search 不替换
check('1i 空 search 返回原文', replaceText('abc', '', 'x').text === 'abc' && replaceText('abc', '', 'x').count === 0);
// 1j 不匹配
check('1j 不匹配 count=0', replaceText('abc', 'zzz', 'x').count === 0 && replaceText('abc', 'zzz', 'x').text === 'abc');
// 1k 整词匹配边界（行首行尾）
check('1k 行首行尾整词', replaceText('foo\nxfoo\nfoo\n', 'foo', 'Y', { wholeWord: true, replaceAll: true }).text === 'Y\nxfoo\nY\n');
// 1l 下划线是单词字符
check('1l 下划线算单词字符', replaceText('foo _foo_', 'foo', 'Y', { wholeWord: true }).text === 'Y _foo_');
// 1m 替换串含特殊字符（普通字符串非正则）
check('1m 特殊字符按普通字符串处理', replaceText('a.b a.b', 'a.b', 'c', { caseSensitive: true, replaceAll: true }).text === 'c c');
// 1n findMatches 行号
const matches = findMatches('foo\nbar\nfoo', 'foo');
check('1n findMatches 行号', matches.length === 2 && matches[0].line === 1 && matches[1].line === 3,
  JSON.stringify(matches.map(m => m.line)));

// ── 2. 集成：工具执行 ──
(async () => {
  const target = path.join(TMP_DIR, 'sample.ts');
  const FIXTURE = 'const foo = 1;\nconst fooBar = 2;\nconsole.log(foo);\n';
  fs.writeFileSync(target, FIXTURE, 'utf8');

  // 2a 默认非全量：多处匹配拒绝执行
  let res = await replaceStrTool.execute({ filePath: target, search: 'foo', replace: 'baz' } as any);
  check('2a 多处匹配默认拒绝', String(res).includes('拒绝执行') && String(res).includes('3 处'), String(res).slice(0, 200));
  let content = fs.readFileSync(target, 'utf8');
  check('2b 拒绝时不写盘', content === FIXTURE, content);

  // 2c replaceAll=true 全量替换
  res = await replaceStrTool.execute({ filePath: target, search: 'foo', replace: 'baz', replaceAll: true } as any);
  check('2c 全量替换成功', String(res).includes('[REPLACE]') && String(res).includes('已替换 3 处'), String(res).slice(0, 200));
  content = fs.readFileSync(target, 'utf8');
  check('2d 全量内容正确', content === 'const baz = 1;\nconst bazBar = 2;\nconsole.log(baz);\n', content);

  // 2e 大小写敏感不匹配（默认已是敏感）
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'FOO', replace: 'x' } as any);
  check('2e 敏感不匹配报错', String(res).includes('未找到匹配'), String(res).slice(0, 120));
  content = fs.readFileSync(target, 'utf8');
  check('2f 未匹配不写文件', content === FIXTURE, content);

  // 2g 整词全量替换（跳过 fooBar）
  res = await replaceStrTool.execute({ filePath: target, search: 'foo', replace: 'baz', wholeWord: true, replaceAll: true } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2g 整词全量结果', content === 'const baz = 1;\nconst fooBar = 2;\nconsole.log(baz);\n', content);

  // 2h 唯一匹配默认成功（无需 replaceAll）
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'log(foo)', replace: 'log(baz)' } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2h 唯一匹配默认成功', content === 'const foo = 1;\nconst fooBar = 2;\nconsole.log(baz);\n', content);

  // 2i 语法错误拦截：把 const 替换掉破坏语法
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'const foo = 1;', replace: '???' } as any);
  check('2i 语法错误被拦截', String(res).includes('插入未成功') || String(res).includes('语法'), String(res).slice(0, 200));
  content = fs.readFileSync(target, 'utf8');
  check('2j 语法错误未写盘', content === FIXTURE, content);

  // 2k force 跳过语法检查
  res = await replaceStrTool.execute({ filePath: target, search: 'const foo = 1;', replace: '???', force: true } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2k force 跳过写入', content.includes('???'), content);

  // 2l undo_patch 撤销
  const undoRes = await undoPatch.execute({} as any);
  content = fs.readFileSync(target, 'utf8');
  check('2l undo 撤销 replace', content === FIXTURE, content.slice(0, 200));

  // 2m 删除匹配（replace 空，多处需 replaceAll）
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'const ', replace: '', replaceAll: true } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2m 删除匹配', !content.includes('const ') && content.includes('foo = 1;'), content);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();
