/**
 * 编辑层增强测试：替换块结构预检 / 错误定位映射 / wrap_by_label / find_matching_label
 * 运行：pnpm tsx scripts/test-edit-layer-enhancement.ts
 */
import * as fs from 'node:fs';
import { precheckReplacement, formatSyntaxErrors, checkSyntax } from '../src/tools/syntax-validator.js';
import { addPatch } from '../src/tools/file-manipulation.js';
import { wrapByLabel } from '../src/tools/inner_skills/code-edit-detector/scripts/wrap-by-label.js';
import { findMatchingLabel } from '../src/tools/inner_skills/code-edit-detector/scripts/find-matching-label.js';

const target = 'scripts/__edit_enhance_target.tsx';
const FIXTURE = [
  "import React from 'react';",
  '',
  'export function Panel({ show }: { show: boolean }) {',
  '  return (',
  '    <div className="panel">',
  '      {show ? (',
  '        <span>yes</span>',
  '      ) : (',
  '        <span>no</span>',
  '      )}',
  '    </div>',
  '  );',
  '}',
  '',
];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}

try {
  // ── 1. precheckReplacement：平衡块 ──
  const balanced = [
    '  const list = [1, 2, 3];',
    '  return (',
    '    <div>',
    '      {list.map(x => <span key={x}>{x}</span>)}',
    '    </div>',
    '  );',
  ];
  const r1 = precheckReplacement(target, balanced);
  check('1a 平衡块通过', r1.ok, JSON.stringify(r1.issues));

  // ── 2. 缺括号 / 多括号 ──
  const missingClose = ['  if (a > 0) {', '    return 1;'];
  const r2 = precheckReplacement(target, missingClose);
  check('2a 缺 } 检出', !r2.ok && r2.issues.some(i => i.message.includes('未闭合的括号') && i.line === 1), JSON.stringify(r2.issues));

  const extraClose = ['  const x = 1;', '  }', '}'];
  const r3 = precheckReplacement(target, extraClose);
  check('2b 多 } 检出', !r3.ok && r3.issues.some(i => i.message.includes('多余的闭括号')), JSON.stringify(r3.issues));

  // ── 3. JSX 标签失衡 ──
  const missingTag = ['  return (', '    <div>', '      <span>hi</span>', '  );'];
  const r4 = precheckReplacement(target, missingTag);
  check('3a 缺 </div> 检出', !r4.ok && r4.issues.some(i => i.message.includes('未闭合的标签 <div>')), JSON.stringify(r4.issues));

  const extraTag = ['  return (', '    </div>', '    <div>x</div>', '  );'];
  const r5 = precheckReplacement(target, extraTag);
  check('3b 多 </div> 检出', !r5.ok && r5.issues.some(i => i.message.includes('多余的闭合标签')), JSON.stringify(r5.issues));

  // 字符串/模板字符串内的括号不误报
  const stringBrackets = ["  const s = '}';", '  const t = `{{ x }}`;', '  const u = "(";'];
  const r6 = precheckReplacement(target, stringBrackets);
  check('3c 字符串内括号不误报', r6.ok, JSON.stringify(r6.issues));

  // 非 tsx（如 .css）不做标签检查
  const r7 = precheckReplacement('x.css', missingTag);
  check('3d 非 tsx 只查括号', r7.ok, JSON.stringify(r7.issues));

  // ── 4. formatSyntaxErrors：区域标注 + 预检提示 ──
  const badReplacement = ['  return (', '    <div>', '      {x}', '  );'];
  const badNewLines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']; // 替换区域 2-5
  const errResult = {
    ok: false,
    errors: [
      { message: 'JSX element has no corresponding closing tag.', line: 5, column: 3 },
      { message: 'Unexpected token.', line: 9, column: 1 },
    ],
  };
  const errMsg = formatSyntaxErrors(errResult, {
    newLines: badNewLines,
    replaceRange: { start: 2, end: 5 },
    precheck: precheckReplacement(target, badReplacement),
  });
  check('4a 区域标注：区域内', errMsg.includes('[替换区域内·相对替换块第 4 行]'), errMsg);
  check('4b 区域外错误折叠为汇总', errMsg.includes('另有 1 条错误位于替换区域外') && !errMsg.includes('[替换区域之前') && !errMsg.includes('[替换区域之后'), errMsg);
  check('4c 预检提示存在', errMsg.includes('替换块结构预检') && errMsg.includes('未闭合的标签'), errMsg);
  check('4d 预览标题明确', errMsg.includes('应用修改后的文件预览'), errMsg);

  // ── 5. wrap_by_label：实际文件包裹 ──
  fs.writeFileSync(target, FIXTURE.join('\n'), 'utf8');
  const w1 = await wrapByLabel.execute({ filePath: target, startLine: 5, endLine: 11, tagName: 'section', attrs: 'className="wrap"' } as any);
  let content = fs.readFileSync(target, 'utf8');
  check('5a 开标签插入', content.includes('    <section className="wrap">'), String(w1));
  check('5b 闭标签插入', content.includes('    </section>'), content);
  check('5c 范围内行加一级缩进', content.includes('      {show ? ('), content);
  check('5d 范围外缩进不变', content.includes('    <div className="panel">'), content);
  const w2 = await wrapByLabel.execute({ filePath: target, startLine: 1, endLine: 2, tagName: '123bad' } as any);
  check('5e 非法标签名拒绝', String(w2).includes('无效的标签名'), String(w2));

  // ── 6. find_matching_label：开→闭 / 闭→开 / 嵌套 ──
  fs.writeFileSync(target, FIXTURE.join('\n'), 'utf8');
  const f1 = JSON.parse(await findMatchingLabel.execute({ filePath: target, lineNumber: 5 } as any));
  check('6a 开标签→闭标签', f1.type === 'open-to-close' && f1.tagName === 'div' && f1.closeLine === 11, JSON.stringify(f1));
  const f2 = JSON.parse(await findMatchingLabel.execute({ filePath: target, lineNumber: 11 } as any));
  check('6b 闭标签→反向开标签', f2.type === 'close-to-open' && f2.openLine === 5, JSON.stringify(f2));
  const f3 = JSON.parse(await findMatchingLabel.execute({ filePath: target, lineNumber: 7, tagName: 'span' } as any));
  check('6c 指定 tagName + 同行开闭', f3.tagName === 'span' && f3.openLine === 7 && f3.closeLine === 7, JSON.stringify(f3));
  const f4 = JSON.parse(await findMatchingLabel.execute({ filePath: target, lineNumber: 7 } as any));
  check('6d 自动检测标签', f4.tagName === 'span' && f4.closeLine === 7, JSON.stringify(f4));

  // ── 7. 集成：add_patch 提交不平衡插入块 → 报错含预检提示 ──
  const badReplace = [
    '      {show ? (',
    '        <span>yes</span>',
    '      ) : (',
    '        <span>no</span>',
    '      )', // 缺闭合 } → 插入块自身不平衡
  ];
  const m1 = await addPatch.execute({ filePath: target, lineIndex: 5, Lines: badReplace } as any);
  const m1str = String(m1);
  check('7a 不平衡插入块被拦截', m1str.includes('插入未成功'), m1str.slice(0, 200));
  check('7b 报错含替换块预检', m1str.includes('替换块结构预检'), m1str.slice(0, 300));
  check('7c 文件未被写入', fs.readFileSync(target, 'utf8') === FIXTURE.join('\n'), fs.readFileSync(target, 'utf8').slice(-120));

  // 平衡的插入块应成功
  const goodReplace = [
    '      {show ? (',
    '        <b>yes</b>',
    '      ) : (',
    '        <b>no</b>',
    '      )}',
  ];
  const m2 = await addPatch.execute({ filePath: target, lineIndex: 5, Lines: goodReplace } as any);
  check('7d 平衡插入块成功', String(m2).includes('[ADD]'), String(m2).slice(0, 100));
  check('7e 内容已更新', fs.readFileSync(target, 'utf8').includes('<b>yes</b>'), fs.readFileSync(target, 'utf8'));

  // 8. 复现截图场景：模拟"多带一个 </div>"的经典错误
  const dupDivReplace = [
    '    <div className="panel">', // 多带的 div（原范围外的行也被替换进来）
    '      {show ? (',
    '        <span>yes</span>',
    '      ) : (',
    '        <span>no</span>',
    '      )}',
  ];
  fs.writeFileSync(target, FIXTURE.join('\n'), 'utf8');
  const m3 = await addPatch.execute({ filePath: target, lineIndex: 3, Lines: dupDivReplace } as any);
  const m3str = String(m3);
  check('8a 重复 div 被预检发现', m3str.includes('多余的闭合标签') || m3str.includes('未闭合的标签'), m3str.slice(0, 300));
} finally {
  try { fs.unlinkSync(target); } catch { /* ignore */ }
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}









