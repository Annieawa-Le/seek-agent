/**
 * patch-history 测试：验证 .diff 文件的正文提取不会破坏 unified diff 的前缀。
 *
 * 背景（回归用例）：主进程一度用 `raw.slice(sep + 60).trim()` 取正文，
 * 而正文每行都带 1 字符前缀、首行是上下文行（前缀就是一个空格），
 * trim 把这个空格吃掉后 parseHunk 直接判整条记录非法 —— 内联差异永远出不来。
 *
 * 运行：pnpm tsx scripts/test-patch-history.ts
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { extractPatchBody, parsePatchMeta, truncatePatchBody, PATCH_SEP } from '../electron/patch-history.js';
import { parseHunk } from '../electron/renderer/src/utils/patch-merge.ts';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 拼一份 .diff 文件全文（与 src/tools/patch-diff.ts 的落盘格式一致） */
function diffFile(meta: Record<string, unknown>, body: string): string {
  return `${JSON.stringify({ meta }, null, 2)}\n${PATCH_SEP}\n${body}\n`;
}

/* ── 1. 正文提取：前导空格必须原样保留 ── */
console.log('\n[1] extractPatchBody 保留前缀空格');
{
  // 首行是上下文行（前缀是空格），末行也是上下文行
  const body = ' import { a } from "a";\n-const x = 1;\n+const x = 2;\n export default x;';
  const raw = diffFile({ id: 'p1', filePath: 'D:/a.ts', timestamp: 1, type: 'modify' }, body);
  const got = extractPatchBody(raw);

  check('首字符仍是上下文前缀空格', got?.startsWith(' ') === true, JSON.stringify(got?.slice(0, 12)));
  check('正文与写入时逐字节一致', got === body, JSON.stringify(got));
  check('parseHunk 能解析', parseHunk(got ?? '') !== null);
  check('解析出的前文上下文正确', JSON.stringify(parseHunk(got ?? '')?.before) === JSON.stringify(['import { a } from "a";']));

  // 对照：旧实现的 trim 会吃掉首行前缀空格，直接解析失败
  check('对照：trim 后解析失败（即旧 bug）', parseHunk(body.trim()) === null);
}

/* ── 2. 两端多余换行被剥掉，中间内容不动 ── */
console.log('\n[2] 两端换行剥离');
{
  const body = ' keep\n-old\n+new\n keep';
  const raw = `${JSON.stringify({ meta: { filePath: 'D:/b.ts' } })}\n${PATCH_SEP}\n\n\n${body}\n\n`;
  const got = extractPatchBody(raw);
  check('前导空行被剥掉', got?.startsWith(' keep') === true);
  check('末尾空行被剥掉', got?.endsWith(' keep') === true);
  check('内容未被改动', got === body);
}

/* ── 3. 元信息解析 ── */
console.log('\n[3] parsePatchMeta');
{
  const raw = diffFile(
    { id: 'p9', filePath: 'D:/c.ts', timestamp: 1790969768992, type: 'add', description: '写入行' },
    ' a\n+b',
  );
  const meta = parsePatchMeta(raw);
  check('meta 解析成功', !!meta);
  check('filePath 正确', meta?.filePath === 'D:/c.ts', String(meta?.filePath));
  check('timestamp 为数字', typeof meta?.timestamp === 'number');
  check('无分隔线返回 null', parsePatchMeta('not a diff file') === null);
  check('无分隔线正文返回 null', extractPatchBody('not a diff file') === null);
}

/* ── 4. 集成：真实历史文件 ── */
console.log('\n[4] 真实 .seek-agent/history 集成校验');
{
  const dir = join(process.cwd(), '.seek-agent', 'history');
  if (!existsSync(dir)) {
    console.log('  \x1b[33m·\x1b[0m 未找到历史目录，跳过');
  } else {
    const names = readdirSync(dir).filter(n => n.endsWith('.diff')).sort().reverse().slice(0, 300);
    let scanned = 0;
    let fixedOk = 0;
    let trimOk = 0;
    let badBody: string[] = [];

    for (const name of names) {
      let raw: string;
      try { raw = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
      const body = extractPatchBody(raw);
      if (body === null || !body.trim()) continue;
      scanned += 1;
      if (parseHunk(body)) fixedOk += 1;
      else if (badBody.length < 3) badBody.push(name);
      if (parseHunk(body.trim())) trimOk += 1;
    }

    console.log(`  扫描 ${scanned} 条有效正文`);
    console.log(`  修复后 parseHunk 通过：${fixedOk} 条`);
    console.log(`  旧实现（trim）通过：${trimOk} 条`);
    if (badBody.length) console.log(`  未通过示例：${badBody.join(', ')}`);

    check('扫到了真实记录', scanned > 0);
    check('修复后全部可解析', scanned > 0 && fixedOk === scanned, `${fixedOk}/${scanned}`);
    check('旧实现确实解析不出来（证明本修复必要）', trimOk < fixedOk, `trim ${trimOk} vs 修复 ${fixedOk}`);
  }
}

/* ── 5. 大 patch 截断：必须切在行边界，截断后仍可解析 ── */
console.log('\n[5] truncatePatchBody 行边界截断');
{
  const body = [' ctx-a', '-old', '+new', ' ctx-b', ' ctx-c'].join('\n');
  check('未超限时原样返回', truncatePatchBody(body, 9999) === body);

  // 上限落在 ' ctx-b' 中间
  const limit = body.indexOf(' ctx-b') + 3;
  const hardCut = body.slice(0, limit);
  // 硬切的残行 ' ct' 仍带空格前缀，解析器不报错、把它当成一条上下文行 ——
  // 于是「文件里根本不存在的一行」混进了锚点，locateHunk 匹配不上，整段改动被静默丢弃
  check('对照：硬切把残行当成上下文行收下', parseHunk(hardCut)?.after?.[0] === 'ct', JSON.stringify(parseHunk(hardCut)?.after));

  const softCut = truncatePatchBody(body, limit);
  const wholeLines = softCut.split('\n').length;
  check('截断结果是原正文的整行前缀', softCut === body.split('\n').slice(0, wholeLines).join('\n'), JSON.stringify(softCut));
  check('末行内容完整未被切坏', softCut.split('\n').at(-1) === '+new', JSON.stringify(softCut.split('\n').at(-1)));
  check('行边界截断后仍可解析', parseHunk(softCut) !== null, JSON.stringify(softCut));
  check('单行超长时退化为硬切', truncatePatchBody('x'.repeat(100), 10) === 'x'.repeat(10));
}

/* ── 6. 集成：真实的大 patch（>20KB 上限的那批） ── */
console.log('\n[6] 真实大 patch 截断校验');
{
  const dir = join(process.cwd(), '.seek-agent', 'history');
  if (!existsSync(dir)) {
    console.log('  \x1b[33m·\x1b[0m 未找到历史目录，跳过');
  } else {
    const big = readdirSync(dir)
      .filter(n => n.endsWith('.diff'))
      .map(n => ({ n, size: statSync(join(dir, n)).size }))
      .filter(f => f.size > 20000)
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);
    let ok = 0;
    let hardCutOk = 0;
    for (const { n } of big) {
      const raw = readFileSync(join(dir, n), 'utf8');
      const body = extractPatchBody(raw) ?? '';
      if (parseHunk(truncatePatchBody(body, 20000))) ok += 1;
      if (parseHunk(body.slice(0, 20000))) hardCutOk += 1;
    }
    console.log(`  抽查 ${big.length} 个超限文件`);
    console.log(`  行边界截断后可解析：${ok} 个`);
    console.log(`  硬切后可解析：${hardCutOk} 个`);
    check('抽查到超限文件', big.length > 0);
    check('行边界截断后全部可解析', ok === big.length, `${ok}/${big.length}`);
  }
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m存在失败\x1b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

