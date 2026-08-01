/**
 * patch-locator 信度匹配测试脚本
 * 运行：pnpm tsx scripts/test-patch-locator.ts
 */
import { contextLocate } from '../src/tools/patch-locator.js';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}

// 模拟一份 100 行的代码文件：行 1-20 头部，行 21-40 目标区，行 41-100 尾部
const lines: string[] = [];
for (let i = 1; i <= 100; i++) lines.push('line ' + i);
// 在 25-27 行制造"目标代码块"
lines[24] = '  const target = {';
lines[25] = '    key: "value",';
lines[26] = '  };';

const pBlock = ['  const target = {', '    key: "value",'];
const eBlock = ['  };'];

// ============ 场景 1：归一化精确匹配 ============
{
  const r = contextLocate(lines, pBlock, eBlock, 30, 30, 20);
  // pretext 匹配 25-26 行 → pretextEndLine = 27；endtext 首行 = 27
  check('1a 归一化精确匹配', r.matched && r.pretextEndLine === 27 && r.endtextStartLine === 27, JSON.stringify(r));
  check('1b 方法为 exact', r.method === 'exact', r.method);
  check('1c 信度为 1', r.confidence === 1, String(r.confidence));
}

// ============ 场景 2：行尾空白差异 ============
{
  const lines2 = ['aaa', 'bbb   ', 'ccc', 'ddd'];
  const r = contextLocate(lines2, ['bbb'], ['ccc'], 1, 1, 20);
  check('2 行尾空白差异可匹配', r.matched && r.pretextEndLine === 3 && r.endtextStartLine === 3, JSON.stringify(r));
}

// ============ 场景 3：内容微差（注释文字略有出入），模糊匹配 ============
{
  const lines3 = ['const a = 1;', '// 旧的注释内容', 'const b = 2;'];
  const r = contextLocate(lines3, ['// 旧注释内容'], ['const b = 2;'], 2, 2, 20);
  check('3 内容微差模糊匹配', r.matched && r.method === 'fuzzy' && r.confidence > 0 && r.confidence < 1,
    JSON.stringify(r));
}

// ============ 场景 4：远距离匹配（旧版 del_patch 用文件中间锚点必失败） ============
{
  // 目标在 25-27 行，锚点 1（文件头），radius=20 窗口 [1,21] 覆盖不到 → 应全局兜底
  const r = contextLocate(lines, pBlock, eBlock, 1, 1, 20);
  check('4a 锚点偏离时全局兜底', r.matched && r.pretextEndLine === 27 && r.endtextStartLine === 27,
    JSON.stringify(r));

  // radius=0 全局搜索
  const r2 = contextLocate(lines, pBlock, eBlock, 50, 50, 0);
  check('4b radius=0 全局搜索', r2.matched && r2.pretextEndLine === 27 && r2.endtextStartLine === 27,
    JSON.stringify(r2));
}

// ============ 场景 5：窗口内优先（两处相似内容取窗口内近处） ============
{
  const lines5 = [...lines];
  // 在 60-62 行放一份几乎相同的内容（只差一个字符）
  lines5[59] = '  const target = {';
  lines5[60] = '    key: "vlaue",'; // 故意拼错
  lines5[61] = '  };';
  // 锚点 60，窗口 [40,80]：窗口内只有 60 行附近候选（模糊），远处 25 行精确候选不应被选中
  const r = contextLocate(lines5, pBlock, eBlock, 60, 60, 20);
  check('5 窗口内优先于远处精确', r.matched && r.pretextEndLine === 62 && r.method === 'fuzzy',
    JSON.stringify(r));
}

// ============ 场景 6：只有 pretext（add_patch 插在 pretext 后） ============
{
  const r = contextLocate(lines, pBlock, undefined, 30, 30, 20);
  check('6 仅 pretext 定位', r.matched && r.pretextEndLine === 27 && r.endtextStartLine === 0, JSON.stringify(r));
}

// ============ 场景 7：只有 endtext ============
{
  const r = contextLocate(lines, undefined, eBlock, 30, 30, 20);
  check('7 仅 endtext 定位', r.matched && r.endtextStartLine === 27, JSON.stringify(r));
}

// ============ 场景 8：完全不匹配应拒绝 ============
{
  const r = contextLocate(lines, ['完全不存在的内容 A', '完全不存在的内容 B'], ['也不存在'], 30, 30, 20);
  check('8a 无匹配时 matched=false', r.matched === false, JSON.stringify(r));
  const r2 = contextLocate(lines, undefined, undefined, 30, 30, 20);
  check('8b 无上下文时 matched=false', r2.matched === false && r2.method === 'none', JSON.stringify(r2));
}

// ============ 场景 9：endtext 必须在 pretext 之后 ============
{
  const lines9 = ['AAA', 'BBB', 'CCC', 'DDD'];
  const r = contextLocate(lines9, ['CCC'], ['AAA'], 2, 2, 20);
  check('9 endtext 在 pretext 之前不匹配', r.matched === false, JSON.stringify(r));
}

// ============ 场景 10：空行参与匹配 ============
{
  const lines10 = ['import a', '', 'import b', '', 'const x = 1;'];
  const r = contextLocate(lines10, ['import a', ''], ['const x = 1;'], 3, 3, 20);
  check('10 空行参与匹配', r.matched && r.pretextEndLine === 3 && r.endtextStartLine === 5, JSON.stringify(r));
}

// ============ 场景 11：\r\n 行尾（Windows 文件） ============
{
  const lines11 = ['abc\r', 'def\r', 'ghi'];
  const r = contextLocate(lines11, ['abc'], ['ghi'], 2, 2, 20);
  check('11 CRLF 归一化', r.matched && r.pretextEndLine === 2 && r.endtextStartLine === 3, JSON.stringify(r));
}

// ============ 场景 12：多行中一行有微差，其余精确 ============
{
  const lines12 = ['fn foo() {', '  let x = 1;', '  return x;', '}', 'fn bar() {', '  return 2;', '}'];
  const r = contextLocate(lines12, ['fn foo() {', '  let x = 2;', '  return x;'], ['}'], 1, 1, 20);
  check('12 多行单行微差仍可匹配', r.matched && r.method === 'fuzzy' && r.pretextEndLine === 4,
    JSON.stringify(r));
}

console.log('\n==============================');
console.log('PASS ' + pass + ' / ' + (pass + fail));
if (fail > 0) process.exit(1);

