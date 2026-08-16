/**
 * test-memory-workspace.ts — 工作记忆改造验证
 *
 * 覆盖：
 *   1. 工作区隔离：切换工作区 + syncMemoryToWorkspace 后，工作/长期记忆按活跃根各自落盘、互不串台
 *   2. 惰性清理（prune）：dreamed 超 48h / 未 dreamed 超 7 天 → list 时自动清除
 *   3. dreamed 降权：markDreamed 后 weight 压到 0.1
 *   4. 注入 top 10：message hook 注入的 [工作记忆] 只含最近访问的 10 条
 *   5. WeightedLRU 容量淘汰仍正常（30 条上限）
 *
 * 注意：测试全程在临时目录进行，结束时恢复真实工作区并重载记忆，不触碰真实记忆文件。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  workingMemory,
  longTermMemory,
  syncMemoryToWorkspace,
  type WorkingMemoryItem,
} from '../src/tools/memory-core';
import { formatWorkingMemory } from '../src/tools/memory';
import { createMessageHook } from '../src/message_managing';
import {
  setWorkspaceRoot,
  resetWorkspaceRoot,
  getWorkspaceRoot,
} from '../src/workdir';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 临时目录：A/B 两个"工作区" */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
const wsA = path.join(tmpRoot, 'wsA');
const wsB = path.join(tmpRoot, 'wsB');
fs.mkdirSync(wsA, { recursive: true });
fs.mkdirSync(wsB, { recursive: true });

function memFile(ws: string): string {
  return path.join(ws, '.seek-agent', 'memory', 'working.json');
}
function ltFile(ws: string): string {
  return path.join(ws, '.seek-agent', 'memory', 'long-term.json');
}

// ═════════════════════════════════════════════════════
// 0. 切到临时工作区 A，隔离真实记忆
// ═════════════════════════════════════════════════════
console.log('\n── 0. 切到临时工作区 A（隔离真实记忆）──');
setWorkspaceRoot(wsA);
syncMemoryToWorkspace();
ok('初始工作区为 A', getWorkspaceRoot() === wsA);
ok('A 无记忆文件时工作记忆为空', workingMemory.size === 0);

// ═════════════════════════════════════════════════════
// 1. 工作区隔离：A/B 各自落盘、切换重载
// ═════════════════════════════════════════════════════
console.log('\n── 1. 工作区隔离 ──');
workingMemory.add('工作区A的焦点任务', 3);
workingMemory.add('工作区A的约定', 1);
ok('A 写入 2 条', workingMemory.size === 2);
ok('A 已落盘 working.json', fs.existsSync(memFile(wsA)));

// 切到 B
setWorkspaceRoot(wsB);
syncMemoryToWorkspace();
ok('切到 B 后工作记忆清空（B 无文件）', workingMemory.size === 0);
workingMemory.add('工作区B的任务', 3);
ok('B 写入 1 条', workingMemory.size === 1);
ok('B 落盘独立文件', fs.existsSync(memFile(wsB)));

// 切回 A：应看到 A 的 2 条，看不到 B 的
setWorkspaceRoot(wsA);
syncMemoryToWorkspace();
const aItems = workingMemory.list();
ok('切回 A 恢复 2 条', aItems.length === 2);
ok('A 的内容正确', aItems.every((it) => it.content.startsWith('工作区A')));
ok('B 的记忆未串台', !aItems.some((it) => it.content.includes('工作区B')));

// 长期记忆同样按工作区隔离（直接构造文件，避免依赖 embedding）
fs.writeFileSync(
  ltFile(wsA),
  JSON.stringify({
    nextId: 2,
    items: [{ id: 1, content: '事实：A 的长期知识', embedding: [], createdAt: Date.now() }],
  }),
  'utf-8',
);
setWorkspaceRoot(wsA);
syncMemoryToWorkspace();
ok('长期记忆 A 加载 1 条', longTermMemory.count === 1);
setWorkspaceRoot(wsB);
syncMemoryToWorkspace();
ok('长期记忆 B 为 0（不串台）', longTermMemory.count === 0);
setWorkspaceRoot(wsA);
syncMemoryToWorkspace();
ok('长期记忆切回 A 恢复 1 条', longTermMemory.count === 1);

// ═════════════════════════════════════════════════════
// 2. 惰性清理（prune）
// ═════════════════════════════════════════════════════
console.log('\n── 2. 惰性清理（prune）──');
workingMemory.clear();
ok('清理后为空', workingMemory.size === 0);

const HOUR = 3600 * 1000;
// dreamed 且 49h 前 → 应被清
const dOld = workingMemory.add('已沉淀的旧决策(49h)', 3);
workingMemory.markDreamed([dOld.id]);
(dOld as WorkingMemoryItem).lastAccess = Date.now() - 49 * HOUR;
// 未 dreamed 且 8 天前 → 应被清
const sOld = workingMemory.add('久未碰的瞬时(8d)', 0.5);
(sOld as WorkingMemoryItem).lastAccess = Date.now() - 8 * 24 * HOUR;
// dreamed 但 1h 前 → 保留
const dNew = workingMemory.add('刚沉淀的条目(1h)', 3);
workingMemory.markDreamed([dNew.id]);
(dNew as WorkingMemoryItem).lastAccess = Date.now() - 1 * HOUR;
// 未 dreamed 且 1h 前 → 保留
const sNew = workingMemory.add('进行中的焦点(1h)', 3);
(sNew as WorkingMemoryItem).lastAccess = Date.now() - 1 * HOUR;

const afterPrune = workingMemory.list();
ok('超龄 dreamed 被清', !afterPrune.some((it) => it.id === dOld.id));
ok('超龄未 dreamed 被清', !afterPrune.some((it) => it.id === sOld.id));
ok('新 dreamed 保留', afterPrune.some((it) => it.id === dNew.id));
ok('新未 dreamed 保留', afterPrune.some((it) => it.id === sNew.id));
ok('清理后剩 2 条', afterPrune.length === 2);

// ═════════════════════════════════════════════════════
// 3. dreamed 降权
// ═════════════════════════════════════════════════════
console.log('\n── 3. dreamed 降权 ──');
workingMemory.clear();
const imp = workingMemory.add('重要待办', 4);
workingMemory.markDreamed([imp.id]);
ok('markDreamed 后 weight 降为 0.1', workingMemory.get(imp.id)!.weight === 0.1);

// ═════════════════════════════════════════════════════
// 4. 注入只取 top 10
// ═════════════════════════════════════════════════════
console.log('\n── 4. 注入 top 10 ──');
workingMemory.clear();
for (let i = 1; i <= 12; i++) {
  workingMemory.add(`焦点条目${String(i).padStart(2, '0')}`, i <= 2 ? 3 : 1);
}
// 模拟"最近访问"：touch 最后一条，让它排最前
const hook = createMessageHook({});
const injected = hook([]);
const wmMsg = injected.find(
  (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[工作记忆]'),
) as { role: string; content: string } | undefined;
ok('hook 注入了 [工作记忆] 消息', !!wmMsg);
if (wmMsg) {
  const lineCount = (wmMsg.content.match(/\(w:/g) || []).length;
  ok('注入条数为 10（而非 12）', lineCount === 10, `实际 ${lineCount}`);
  ok('注入的是最近访问的条目（含焦点12）', wmMsg.content.includes('焦点条目12'));
  ok('未注入最早条目（焦点01）', !wmMsg.content.includes('焦点条目01'));
}
// formatWorkingMemory 直接输出 10 条
ok('formatWorkingMemory 输出 10 行', formatWorkingMemory(workingMemory.list().slice(0, 10)).split('\n').length === 10);

// ═════════════════════════════════════════════════════
// 5. WeightedLRU 容量淘汰仍正常
// ═════════════════════════════════════════════════════
console.log('\n── 5. WeightedLRU 容量淘汰 ──');
workingMemory.clear();
for (let i = 0; i < 35; i++) {
  workingMemory.add(`批量条目${i}`, 1);
}
ok('超容量后稳定在 30 条', workingMemory.size === 30);

// ═════════════════════════════════════════════════════
// 收尾：恢复真实工作区并重载
// ═════════════════════════════════════════════════════
resetWorkspaceRoot();
syncMemoryToWorkspace();
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
