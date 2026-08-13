/**
 * test-replace-str.ts — replace_str 快速替换工具测试
 */
import { replaceText } from '../src/tools/replace-str';
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

// ── 1. replaceText 纯函数 ──
// 1a 默认大小写不敏感
check('1a 默认大小写不敏感', replaceText('Foo foo FOO', 'foo', 'bar').text === 'bar bar bar');
// 1b 大小写敏感
check('1b 大小写敏感', replaceText('Foo foo FOO', 'foo', 'bar', { caseSensitive: true }).text === 'Foo bar FOO');
// 1c 大小写敏感 + 计数
check('1c 计数正确', replaceText('Foo foo FOO', 'foo', 'bar', { caseSensitive: true }).count === 1);
// 1d 整词匹配（foo 前后是单词字符不替换）
check('1d 整词匹配', replaceText('foo foobar bar foo', 'foo', 'X', { wholeWord: true }).text === 'X foobar bar X');
// 1e 整词匹配 + 大小写敏感
check('1e 整词+敏感', replaceText('Foo foo', 'foo', 'X', { wholeWord: true, caseSensitive: true }).text === 'Foo X');
// 1f replaceAll=false 只替换第一处
check('1f 只替换第一处', replaceText('a a a', 'a', 'b', { replaceAll: false }).text === 'b a a');
// 1g replaceAll=false 计数
check('1g 只替换第一处计数', replaceText('a a a', 'a', 'b', { replaceAll: false }).count === 1);
// 1h replace 空串 = 删除
check('1h 删除匹配', replaceText('abc def abc', 'abc', '').text === ' def ');
// 1i search 空串不替换
check('1i 空 search 返回原文', replaceText('abc', '', 'x').text === 'abc' && replaceText('abc', '', 'x').count === 0);
// 1j 不匹配
check('1j 不匹配 count=0', replaceText('abc', 'zzz', 'x').count === 0 && replaceText('abc', 'zzz', 'x').text === 'abc');
// 1k 整词匹配边界（行首行尾）
check('1k 行首行尾整词', replaceText('foo\nxfoo\nfoo\n', 'foo', 'Y', { wholeWord: true }).text === 'Y\nxfoo\nY\n');
// 1l 下划线是单词字符
check('1l 下划线算单词字符', replaceText('foo _foo_', 'foo', 'Y', { wholeWord: true }).text === 'Y _foo_');
// 1m 替换串含特殊字符（普通字符串非正则）
check('1m 特殊字符按普通字符串处理', replaceText('a.b a.b', 'a.b', 'c', { caseSensitive: true }).text === 'c c');

// ── 2. 集成：工具执行 ──
(async () => {
  const target = path.join(TMP_DIR, 'sample.ts');
  const FIXTURE = 'const foo = 1;\nconst fooBar = 2;\nconsole.log(foo);\n';
  fs.writeFileSync(target, FIXTURE, 'utf8');

  // 2a 基本替换（全部）
  let res = await replaceStrTool.execute({ filePath: target, search: 'foo', replace: 'baz' } as any);
  check('2a 基本替换成功', String(res).includes('[REPLACE]') && String(res).includes('已替换 3 处'), String(res).slice(0, 200));
  let content = fs.readFileSync(target, 'utf8');
  check('2b 内容正确', content === 'const baz = 1;\nconst bazBar = 2;\nconsole.log(baz);\n', content);

  // 2c 大小写敏感
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'FOO', replace: 'x', caseSensitive: true } as any);
  check('2c 敏感不匹配报错', String(res).includes('未找到匹配'), String(res).slice(0, 120));
  content = fs.readFileSync(target, 'utf8');
  check('2d 未匹配不写文件', content === FIXTURE, content);

  // 2e 整词替换
  res = await replaceStrTool.execute({ filePath: target, search: 'foo', replace: 'baz', wholeWord: true } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2e 整词替换结果', content === 'const baz = 1;\nconst fooBar = 2;\nconsole.log(baz);\n', content);

  // 2f replaceAll=false
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'foo', replace: 'baz', replaceAll: false } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2f 只替换第一处', content === 'const baz = 1;\nconst fooBar = 2;\nconsole.log(foo);\n', content);

  // 2g 语法错误拦截：把 const 替换掉破坏语法
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'const foo = 1;', replace: '???', } as any);
  check('2g 语法错误被拦截', String(res).includes('插入未成功') || String(res).includes('语法'), String(res).slice(0, 200));
  content = fs.readFileSync(target, 'utf8');
  check('2h 语法错误未写盘', content === FIXTURE, content);

  // 2i force 跳过语法检查
  res = await replaceStrTool.execute({ filePath: target, search: 'const foo = 1;', replace: '???', force: true } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2i force 跳过写入', content.includes('???'), content);

  // 2j undo_patch 撤销
  const undoRes = await undoPatch.execute({} as any);
  content = fs.readFileSync(target, 'utf8');
  check('2j undo 撤销 replace', content === FIXTURE, content.slice(0, 200));

  // 2k 删除匹配（replace 空）
  fs.writeFileSync(target, FIXTURE, 'utf8');
  res = await replaceStrTool.execute({ filePath: target, search: 'const ', replace: '' } as any);
  content = fs.readFileSync(target, 'utf8');
  check('2k 删除匹配', !content.includes('const ') && content.includes('foo = 1;'), content);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();


