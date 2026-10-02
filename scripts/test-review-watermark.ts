/**
 * 审查水位线（按文件）的纯逻辑测试。
 *
 * 覆盖 raiseWatermark / watermarkOf / pendingOf 三个导出函数——
 * 它们是「只标当前文件」「只撤当前文件」这两条精准化语义的核心。
 *
 * 运行：pnpm tsx scripts/test-review-watermark.ts
 */
import { raiseWatermark, watermarkOf, pendingOf, normPath, parseWatermarks } from '../electron/renderer/src/utils/review-watermark.ts';
import type { PatchRecord } from '../electron/renderer/src/types/index.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 造一条改动记录 */
function rec(filePath: string, timestamp: number, id = `${filePath}@${timestamp}`): PatchRecord {
  return { id, filePath, timestamp, type: 'modify', description: '', diff: '' };
}

const A = 'D:/proj/src/a.ts';
const B = 'D:/proj/src/b.ts';

console.log('\n[1] watermarkOf：按文件取水位线');
{
  check('空表 → 0（全部未审查）', watermarkOf({}, A) === 0);
  const w = { [normPath(A)]: 100 };
  check('有记录 → 取该文件的值', watermarkOf(w, A) === 100);
  check('无记录的文件 → 0', watermarkOf(w, B) === 0);
  check('路径大小写/分隔符归一', watermarkOf(w, 'd:\\proj\\src\\A.TS') === 100,
    String(watermarkOf(w, 'd:\\proj\\src\\A.TS')));
  // 迁移来的全局值作为兜底
  check('全局值兜底（未单列的文件）', watermarkOf({ '*': 50 }, B) === 50);
  check('单列值优先于全局值', watermarkOf({ '*': 50, [normPath(A)]: 90 }, A) === 90);
}

console.log('\n[2] pendingOf：按文件各自的水位线过滤');
{
  const patches = [rec(A, 100), rec(A, 200), rec(B, 150), rec(B, 250)];
  check('空水位线 → 全待审', pendingOf(patches, {}).length === 4);
  check('标记 A 到 200 → 只剩 B 的两条', pendingOf(patches, { [normPath(A)]: 200 }).length === 2,
    String(pendingOf(patches, { [normPath(A)]: 200 }).length));
  check('标记 A 后 B 不受影响', pendingOf(patches, { [normPath(A)]: 200 }).every(p => p.filePath === B));
  check('全局水位线兜底生效', pendingOf(patches, { '*': 150 }).length === 2,
    String(pendingOf(patches, { '*': 150 }).length));
}

console.log('\n[3] raiseWatermark：抬水位线到该文件最大记录时间');
{
  const records = [rec(A, 100), rec(A, 300), rec(A, 200)];
  const w = raiseWatermark({}, A, records);
  check('取该文件最大 timestamp（不是 now）', watermarkOf(w, A) === 300, String(watermarkOf(w, A)));
  check('只写该文件的键', Object.keys(w).length === 1 && Object.keys(w)[0] === normPath(A));

  // 关键：不用 now 就不会漏掉「同一毫秒内刚写入的记录」
  const sameMs = raiseWatermark({}, A, [rec(A, 500)]);
  check('水位线 = 记录时间，同毫秒记录不会被跳过', watermarkOf(sameMs, A) === 500);
}

console.log('\n[4] raiseWatermark 的单调性与迁移清理');
{
  const w1 = raiseWatermark({}, A, [rec(A, 300)]);
  const w2 = raiseWatermark(w1, A, [rec(A, 100)]);  // 更小的记录不该把水位线压回去
  check('水位线单调不回退', watermarkOf(w2, A) === 300, String(watermarkOf(w2, A)));

  check('空记录集 → 原样返回', raiseWatermark(w1, A, []) === w1);

  // 迁移来的全局值被按文件的值取代后应清除，否则会一直压低 since 下界
  const migrated = raiseWatermark({ '*': 50 }, A, [rec(A, 300)]);
  check('抬过水位线后清除迁移来的全局键', migrated['*'] === undefined, JSON.stringify(migrated));
  check('清除后其它文件回到「全部未审查」', watermarkOf(migrated, B) === 0);

  // 没抬过的不清（首次只标一个文件时，其它文件仍该受全局值约束）
  const untouched = raiseWatermark({ '*': 50 }, A, []);
  check('无记录时不误清全局键', untouched['*'] === 50);
}

console.log('\n[5] 多文件依次标记：互不干扰');
{
  const patches = [rec(A, 100), rec(B, 200), rec(A, 300), rec(B, 400)];
  let w = {};
  const recsA = patches.filter(p => p.filePath === A);
  const recsB = patches.filter(p => p.filePath === B);

  w = raiseWatermark(w, A, recsA);
  check('只标 A 后，B 的两条仍在待审', pendingOf(patches, w).filter(p => p.filePath === B).length === 2);
  check('只标 A 后，A 的记录全部已审', pendingOf(patches, w).filter(p => p.filePath === A).length === 0);

  w = raiseWatermark(w, B, recsB);
  check('再标 B 后，全部已审（列表清空）', pendingOf(patches, w).length === 0);
  check('A 的水位线未被 B 影响', watermarkOf(w, A) === 300, String(watermarkOf(w, A)));
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m存在失败\x1b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
