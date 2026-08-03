/**
 * 验证记忆消退路径（context-compactor + worklog-store + 召回工具）：
 *  - 双阈值预算判断（MAX_CONTEXT_TOKENS / COMPRESS_TARGET_RATIO）
 *  - 轮次识别 / Worklog 消息识别
 *  - compactMessages 压缩计划生成（移除旧轮次、Worklog 插入、归档落盘）
 *  - 头部旧 Worklog 二级消退（降级为归档行）
 *  - worklog_recall / work_recall 召回
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  compactMessages, findRounds, isWorklogMessage, extractWorklogId,
  checkBudget, maxContextTokens, targetContextTokens,
} from '../src/context-compactor';
import { worklogStore } from '../src/tools/worklog-store';
import { worklogRecallTool, workRecallTool } from '../src/tools/worklog-tools';
import { getWorkspaceRoot } from '../src/workdir';
import type { ModelMessage } from 'ai';

const TEST_SESSION = 'test-ctx-compactor';
const asserts: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { asserts.push({ name, ok }); }

// 测试注入的假梗概生成器：避免真实调用副模型（纯逻辑测试，不依赖网络）
const fakeSummarize = async (msgs: ModelMessage[]) => ({
  title: '测试梗概',
  summary: '【标题】测试梗概\n【用户意图】测试用\n【关键决策】无\n【文件改动】无\n【待办】无\n【取回指引】无',
});
function mkRound(user: string, idx: number): ModelMessage[] {
  const msgs: ModelMessage[] = [{ role: 'user', content: user }];
  msgs.push({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: `call-${idx}`, toolName: 'read_file', input: { filePath: `f${idx}.ts` } }],
  } as ModelMessage);
  msgs.push({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: `call-${idx}`, toolName: 'read_file', output: { type: 'text', value: `文件${idx}内容`.repeat(30) } }],
  } as ModelMessage);
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: `回复：${user}` }] } as ModelMessage);
  return msgs;
}

function buildMessages(roundCount: number): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  for (let i = 1; i <= roundCount; i++) msgs.push(...mkRound(`用户问题${i}`, i));
  return msgs;
}

// ── 1. 预算配置（双阈值） ──
const oldMax = process.env.MAX_CONTEXT_TOKENS;
delete process.env.MAX_CONTEXT_TOKENS;
check('默认触发线 100000', maxContextTokens() === 100000);
check('默认停止线 75000', targetContextTokens() === 75000);
process.env.MAX_CONTEXT_TOKENS = '5000';
check('env 覆盖触发线', maxContextTokens() === 5000);
check('停止线按比例计算', targetContextTokens() === 3750);
check('checkBudget 超限为 true', checkBudget(6000) === true);
check('checkBudget 未超限为 false', checkBudget(4000) === false);
delete process.env.MAX_CONTEXT_TOKENS;
if (oldMax !== undefined) process.env.MAX_CONTEXT_TOKENS = oldMax;

// ── 2. 轮次 / Worklog 识别 ──
const msgs = buildMessages(4);
check('findRounds 识别 4 轮', findRounds(msgs).length === 4);
const wlMsg = { role: 'assistant', content: '[Worklog#W1] 测试标题\n梗概' } as ModelMessage;
check('isWorklogMessage 识别', isWorklogMessage(wlMsg));
check('extractWorklogId 提取 W1', extractWorklogId(wlMsg.content as string) === 'W1');
check('普通消息非 Worklog', !isWorklogMessage({ role: 'user', content: 'hi' } as ModelMessage));

// ── 3. worklogStore 基础 ──
worklogStore.setSessionId(TEST_SESSION);
worklogStore.clear();
check('nextId 从 W1 开始', worklogStore.nextId() === 'W1');
worklogStore.add({ id: 'W1', title: '归档一', summary: '梗概一', archivedMessages: [], createdAt: new Date().toISOString() });
check('nextId 自增到 W2', worklogStore.nextId() === 'W2');
check('get W1 命中', worklogStore.get('W1')?.title === '归档一');
check('findByTitle 模糊命中', worklogStore.findByTitle('归档')?.id === 'W1');

// ── 4. compactMessages：未超限 / 轮次不足 ──
process.env.MAX_CONTEXT_TOKENS = '100000';
check('未超限返回 null', (await compactMessages(msgs, TEST_SESSION, 50000)) === null);
check('仅 1 轮返回 null', (await compactMessages(mkRound('只有一个问题', 99), TEST_SESSION, 200000)) === null);
// ── 5. compactMessages：超限 → 压缩计划 ──
process.env.MAX_CONTEXT_TOKENS = '2000';
const plan = await compactMessages(msgs, TEST_SESSION, 10000, fakeSummarize);
check('超限返回计划', plan !== null);
if (plan) {
  check('roundsRemoved > 0', plan.roundsRemoved > 0);
  check('insertMessages 首位是 Worklog', plan.insertMessages.length > 0 && (plan.insertMessages[0].content as string).startsWith('[Worklog#'));
  check('worklog 已写入 store', worklogStore.get(plan.worklog.id)?.id === plan.worklog.id);
  check('归档保留原文消息', (plan.worklog.archivedMessages as any[]).length > 0);
  check('removeCount 与归档消息数一致', plan.removeCount === plan.worklog.archivedMessages.length);
  check('无旧 Worklog 时仅插入 1 条', plan.insertMessages.length === 1);

  // 应用逻辑模拟（与 agent.applyPendingCompaction 同构）
  const applied = [...msgs];
  applied.splice(0, Math.min(plan.removeCount, applied.length), ...plan.insertMessages);
  check('应用后首条是 Worklog', (applied[0].content as string).startsWith('[Worklog#'));
  check('应用后剩余轮次减少', findRounds(applied).length < findRounds(msgs).length);
}

// ── 6. 头部旧 Worklog 二级消退 ──
worklogStore.setSessionId(TEST_SESSION);
const headOld = { role: 'assistant', content: '[Worklog#W1] 归档一\n旧的梗概内容' } as ModelMessage;
const msgs2 = [headOld, ...buildMessages(4)];
const plan2 = await compactMessages(msgs2, TEST_SESSION, 10000, fakeSummarize);
check('旧 Worklog 场景返回计划', plan2 !== null);
if (plan2) {
  const texts = plan2.insertMessages.map((m) => (m.content as string).slice(0, 80));
  check('时间线顺序：归档行在前、新 Worklog 在后', texts[0].includes('已归档') && texts[texts.length - 1].startsWith(`[Worklog#${plan2.worklog.id}]`));
  check('旧 Worklog 降级为归档行', texts.some((t) => t.includes('已归档：归档一')));
  check('归档行带召回提示', texts.some((t) => t.includes('worklog_recall') && t.includes('work_recall')));
  // 新 Worklog 的归档内容应排除旧 Worklog 消息（不重复压缩/归档梗概本身）
  const archivedTexts = (plan2.worklog.archivedMessages as any[]).map((m: any) => (typeof m.content === 'string' ? m.content : ''));
  check('归档排除旧 Worklog', !archivedTexts.some((t) => t.startsWith('[Worklog#')));
}

// ── 6b. 头部有 [工作记忆] 注入消息时仍能收集 Worklog 并降级（hook 每轮注入到最前） ──
worklogStore.setSessionId(TEST_SESSION);
const wmInject = { role: 'user', content: '[工作记忆] 当前对话焦点与任务状态：测试注入' } as ModelMessage;
const msgs3 = [wmInject, headOld, ...buildMessages(4)];
const plan3 = await compactMessages(msgs3, TEST_SESSION, 10000, fakeSummarize);
check('注入消息前置场景返回计划', plan3 !== null);
if (plan3) {
  const texts3 = plan3.insertMessages.map((m) => (m.content as string).slice(0, 80));
  check('跳过注入消息后仍生成归档行', texts3.some((t) => t.includes('已归档：归档一')));
  check('归档行仍在前、新 Worklog 在后', texts3[0].includes('已归档') && texts3[texts3.length - 1].startsWith(`[Worklog#${plan3.worklog.id}]`));
  const wmArchived = (plan3.worklog.archivedMessages as any[]).some((m: any) => typeof m.content === 'string' && (m.content as string).startsWith('[工作记忆]'));
  check('注入消息不进归档内容', !wmArchived);
}

// ── 7. 召回工具 ──
worklogStore.setSessionId(TEST_SESSION);
const recall1 = await worklogRecallTool.execute!({ id: 'W1' } as any, {} as any);
check('worklog_recall 命中 W1', recall1.toString().includes('归档一'));
const recall2 = await worklogRecallTool.execute!({ id: '不存在的id' } as any, {} as any);
check('worklog_recall 未命中有提示', recall2.toString().includes('未找到'));
const recall3 = await workRecallTool.execute!({ id: 'W2' } as any, {} as any);
check('work_recall 命中返回原文', recall3.toString().includes('Worklog'));
const recall4 = await workRecallTool.execute!({ id: 'W9' } as any, {} as any);
check('work_recall 未命中有提示', recall4.toString().includes('未找到'));

// ── 8. 磁盘落盘 ──
const storeFile = path.join(getWorkspaceRoot(), 'sessions', 'worklogs', `${TEST_SESSION}.json`);
check('归档文件落盘', fs.existsSync(storeFile));
if (fs.existsSync(storeFile)) {
  const raw = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
  check('落盘含 entries', Array.isArray(raw.entries) && raw.entries.length > 0);
}

// ── 清理 ──
try { fs.rmSync(storeFile, { force: true }); } catch { /* 忽略 */ }
delete process.env.MAX_CONTEXT_TOKENS;
if (oldMax !== undefined) process.env.MAX_CONTEXT_TOKENS = oldMax;

let failed = 0;
for (const a of asserts) {
  console.log(`${a.ok ? '✅' : '❌'} ${a.name}`);
  if (!a.ok) failed++;
}
console.log(failed === 0 ? `\n全部通过（${asserts.length} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);











