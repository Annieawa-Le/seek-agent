/**
 * test-wrap-persist.ts — wrap_by / wrap_by_label 持久化 diff 路径测试
 * 验证：语法检查、diff 持久化（undo_patch 可撤销）、行尾符保持、尾空行不产生
 */
import { wrapBy } from '../src/tools/inner_skills/code-edit-detector/scripts/wrap-by';
import { wrapByLabel } from '../src/tools/inner_skills/code-edit-detector/scripts/wrap-by-label';
import { undoPatch } from '../src/tools/file-manipulation';
import fs from 'node:fs';
import path from 'node:path';

const TMP_DIR = path.join('scripts', '__wrap-tmp');
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

(async () => {
  // ── wrap_by 基本包裹 ──
  const tsFile = path.join(TMP_DIR, 'sample.ts');
  const FIXTURE = 'function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';
  fs.writeFileSync(tsFile, FIXTURE, 'utf8');

  let res: any = await wrapBy.execute({ filePath: tsFile, startLine: 2, endLine: 3, wrapString: 'if (a > 0)' } as any);
  let out = String(res);
  check('1a wrap_by 成功且返回 diff', out.includes('[WRAP]') && out.includes('--- diff ---'), out.slice(0, 200));
  let content = fs.readFileSync(tsFile, 'utf8');
  check('1b 包裹内容正确', content === 'function f() {\n  if (a > 0) {\n    const a = 1;\n    const b = 2;\n  }\n  return a + b;\n}\n', JSON.stringify(content));
  check('1c 末尾无多余空行', !content.endsWith('\n\n'), JSON.stringify(content.slice(-5)));

  // 撤销
  res = await undoPatch.execute({} as any);
  content = fs.readFileSync(tsFile, 'utf8');
  check('1d undo 撤销 wrap_by', content === FIXTURE, content);

  // ── wrap_by 语法错误拦截 ──
  // 包裹一个非法范围：把 return 之外的部分包起来导致函数体残缺
  fs.writeFileSync(tsFile, FIXTURE, 'utf8');
  res = await wrapBy.execute({ filePath: tsFile, startLine: 2, endLine: 4, wrapString: 'if (x)' } as any);
  content = fs.readFileSync(tsFile, 'utf8');
  // 包裹 2-4 行会让 return 露在 if 外——语法上其实仍合法（函数返回 undefined 分支）……
  // 改为验证 force 路径 + 检查内容确实被写入
  check('1e 语法合法时正常写入', content.includes('if (x) {'), content.slice(0, 120));

  // force 参数存在性
  fs.writeFileSync(tsFile, FIXTURE, 'utf8');
  res = await wrapBy.execute({ filePath: tsFile, startLine: 2, endLine: 3, wrapString: 'try', force: true } as any);
  content = fs.readFileSync(tsFile, 'utf8');
  check('1f force 跳过检查可写', content.includes('try {'), content.slice(0, 120));

  // ── wrap_by 行号越界 ──
  res = await wrapBy.execute({ filePath: tsFile, startLine: 99, endLine: 100, wrapString: 'if (x)' } as any);
  check('1g 行号越界报错', String(res).includes('超出文件范围'), String(res).slice(0, 120));

  // ── wrap_by_label ──
  const jsxFile = path.join(TMP_DIR, 'Comp.tsx');
  const JSX = 'export function Comp() {\n  return (\n    <h1>hi</h1>\n  );\n}\n';
  fs.writeFileSync(jsxFile, JSX, 'utf8');

  res = await wrapByLabel.execute({ filePath: jsxFile, startLine: 3, endLine: 3, tagName: 'div', attrs: 'className="wrap"' } as any);
  out = String(res);
  check('2a wrap_by_label 成功且返回 diff', out.includes('[WRAP]') && out.includes('--- diff ---'), out.slice(0, 200));
  content = fs.readFileSync(jsxFile, 'utf8');
  check('2b 标签包裹正确', content === 'export function Comp() {\n  return (\n    <div className="wrap">\n      <h1>hi</h1>\n    </div>\n  );\n}\n', content);
  check('2c 末尾无多余空行', !content.endsWith('\n\n'));

  res = await undoPatch.execute({} as any);
  content = fs.readFileSync(jsxFile, 'utf8');
  check('2d undo 撤销 wrap_by_label', content === JSX, content);

  // ── 标签包裹破坏 JSX 结构 → 语法拦截 ──
  fs.writeFileSync(jsxFile, JSX, 'utf8');
  res = await wrapByLabel.execute({ filePath: jsxFile, startLine: 3, endLine: 4, tagName: 'div' } as any);
  content = fs.readFileSync(jsxFile, 'utf8');
  // 3-4 行：<h1>hi</h1> 和 ); ——包 div 后 ");" 留在 div 内，JSX 结构被破坏 → 语法检查拦截
  check('2e 破坏 JSX 结构被拦截且未写盘', !String(res).includes('[WRAP]') && content === JSX, content.slice(0, 150));

  // ── CRLF 行尾符保持 ──
  const crlfFile = path.join(TMP_DIR, 'crlf.ts');
  const CRLF_FIXTURE = 'function f() {\r\n  const a = 1;\r\n  const b = 2;\r\n}\r\n';
  fs.writeFileSync(crlfFile, CRLF_FIXTURE, 'utf8');
  res = await wrapBy.execute({ filePath: crlfFile, startLine: 2, endLine: 3, wrapString: 'if (x)' } as any);
  content = fs.readFileSync(crlfFile, 'utf8');
  check('2f CRLF 行尾符保持', content.includes('\r\n  if (x) {\r\n') && !content.includes('\nif (x) {\n'), JSON.stringify(content.slice(0, 80)));

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();

