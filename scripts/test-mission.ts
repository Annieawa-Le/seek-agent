/**
 * 验证任务段（mission）上下文归档工具：
 *  - mission-start 标记起点 / 重复标记拒绝
 *  - mission-accomplish 裁剪区间消息 + 归档落盘（Worklog，无会话条目）+ 配对完整性
 *  - mission-cancel 只清标记、不裁剪
 *  - 异常路径：无标记 / 起点丢失 / 区间为空
 *  - tool-cache 豁免（连续同参调用必须真实执行）
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { missionStart, missionAccomplish, missionCancel } from '../src/tools/mission';
import { worklogStore } from '../src/tools/worklog-store';
import { worklogRecallTool, workRecallTool } from '../src/tools/worklog-tools';
import { toolCache } from '../src/tools/tool-cache';
import { getWorkspaceRoot } from '../src/workdir';

const TEST_SESSION = 'test-mission';
const asserts: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { asserts.push({ name, ok }); }

worklogStore.setSessionId(TEST_SESSION);
worklogStore.clear();

// ── 构造工具 ──
function toolCall(id: string, name: string, input: Record<string, unknown> = {}): any {
  return { type: 'tool-call', toolCallId: id, toolName: name, input };
}
function toolResult(id: string, name: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'text', value } }],
  } as ModelMessage;
}
/** 一段「干活」轮次：assistant 调 read_file → tool result → assistant 纯文本 */
function workRound(idx: number): ModelMessage[] {
  return [
    { role: 'assistant', content: [toolCall(`w-${idx}`, 'read_file', { filePath: `f${idx}.ts` })] } as ModelMessage,
    toolResult(`w-${idx}`, 'read_file', `文件${idx}内容`.repeat(40)),
    { role: 'assistant', content: [{ type: 'text', text: `第 ${idx} 步完成` }] } as ModelMessage,
  ];
}
/** tool-call / tool-result 配对检查（孤儿计数，均为 0 表示结构完整） */
function pairing(messages: ModelMessage[]): { orphanCall: number; orphanResult: number } {
  const calls = new Set<string>(), results = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const p of m.content as any[]) if (p?.type === 'tool-call') calls.add(p.toolCallId);
    }
    if (m.role === 'tool' && Array.isArray(m.content)) {
      for (const p of m.content as any[]) if (p?.type === 'tool-result') results.add(p.toolCallId);
    }
  }
  let orphanCall = 0, orphanResult = 0;
  for (const id of calls) if (!results.has(id)) orphanCall++;
  for (const id of results) if (!calls.has(id)) orphanResult++;
  return { orphanCall, orphanResult };
}

/** 典型场景消息列表：用户请求 → (create_todo + mission-start) → 两轮干活 → mission-accomplish */
function buildScenario(): ModelMessage[] {
  return [
    { role: 'user', content: '帮我重构 patch 定位' },
    {
      role: 'assistant',
      content: [
        toolCall('c-todo', 'create_todo', { name: '重构 patch 定位', steps: ['读代码', '改定位'] }),
        toolCall('c-start', 'mission-start', { name: '重构 patch 定位' }),
      ],
    } as ModelMessage,
    toolResult('c-todo', 'create_todo', '✅ 已创建 todo'),
    toolResult('c-start', 'mission-start', '🚩 已标记任务段起点'),
    ...workRound(1),
    ...workRound(2),
    { role: 'assistant', content: [toolCall('c-acc', 'mission-accomplish', { summary: '概要' })] } as ModelMessage,
  ];
}

const SUMMARY = '重写了 locateDelRanges 的上下文匹配逻辑；改动 src/tools/patch-locator.ts；测试全绿';

// ── 1. mission-start ──
const messages = buildScenario();
const startRes: any = await (missionStart as any).execute({ name: '重构 patch 定位' }, { toolCallId: 'c-start', messages });
check('mission-start 返回 start 动作', startRes.rawBulk.action === 'start' && startRes.rawBulk.name === '重构 patch 定位');
check('mission-start 文本含标记提示', String(startRes).includes('已标记任务段起点'));

const dupRes: any = await (missionStart as any).execute({ name: '另一个任务段' }, { toolCallId: 'c-start-2', messages });
check('重复 mission-start 被拒绝', !!dupRes.rawBulk.error && String(dupRes).includes('已有进行中的任务段'));

// ── 2. mission-accomplish ──
const before = messages.length;
const accRes: any = await (missionAccomplish as any).execute({ summary: SUMMARY }, { toolCallId: 'c-acc', messages });
check('mission-accomplish 返回归档 id', accRes.rawBulk.action === 'accomplish' && accRes.rawBulk.worklogId === 'W1');
check('已裁剪消息', accRes.rawBulk.messagesRemoved === before - 2);
check('消息列表已变短', messages.length === before - (before - 2));
check('剩余首条是用户请求', messages[0].role === 'user' && (messages[0].content as string).includes('重构 patch 定位'));
check('剩余末条是 mission-accomplish 调用', messages[messages.length - 1].role === 'assistant'
  && (messages[messages.length - 1].content as any[]).some((p) => p.toolCallId === 'c-acc'));
check('会话中不留归档条目', !messages.some((m) => typeof m.content === 'string' && m.content.includes('Worklog#')));
// agent 在工具返回后才 push 本次调用的 tool-result，模拟后再验结构完整性
messages.push(toolResult('c-acc', 'mission-accomplish', String(accRes)));
const p = pairing(messages);
check('裁剪后 tool-call/result 配对完整', p.orphanCall === 0 && p.orphanResult === 0);
check('裁剪已丢弃区间内的 tool-call（无残留调用）', !JSON.stringify(messages).includes('c-todo'));

const entry = worklogStore.get('W1');
check('Worklog 已写入 store', !!entry);
check('归档标题取自任务段名', entry?.title === '重构 patch 定位');
check('归档梗概即 summary', entry?.summary === SUMMARY);
check('归档保留原文消息', (entry?.archivedMessages as any[])?.length === before - 2);
check('归档含区间原文', JSON.stringify(entry?.archivedMessages).includes('文件1内容'));
check('id 自增到 W2', worklogStore.nextId() === 'W2');

// ── 3. 召回 ──
const recall1: any = await (worklogRecallTool as any).execute({ id: 'W1' }, {} as any);
check('worklog_recall 取回梗概', String(recall1).includes('locateDelRanges') && String(recall1).includes('重构 patch 定位'));
const recall2: any = await (workRecallTool as any).execute({ id: 'W1' }, {} as any);
check('work_recall 取回原文', String(recall2).includes('文件2内容'));

// ── 4. 成对性：无标记直接 accomplish ──
const noStart: any = await (missionAccomplish as any).execute({ summary: 'x' }, { toolCallId: 'c-x', messages });
check('无进行中任务段时提示成对使用', String(noStart).includes('没有进行中的任务段'));

// ── 5. mission-cancel：清标记但不裁剪 ──
const msgs2 = buildScenario();
await (missionStart as any).execute({ name: '中止的任务段' }, { toolCallId: 'c-start', messages: msgs2 });
const lenBeforeCancel = msgs2.length;
const cancelRes: any = await (missionCancel as any).execute({}, { messages: msgs2 });
check('mission-cancel 返回 cancel 动作', cancelRes.rawBulk.action === 'cancel');
check('mission-cancel 不裁剪消息', msgs2.length === lenBeforeCancel);
check('mission-cancel 不新增 Worklog', worklogStore.nextId() === 'W2');
const afterCancel: any = await (missionAccomplish as any).execute({ summary: 'x' }, { toolCallId: 'c-acc', messages: msgs2 });
check('取消后 accomplish 视为无标记', String(afterCancel).includes('没有进行中的任务段'));

// ── 6. 起点消息丢失（被记忆消退压缩掉） ──
const msgs3 = buildScenario().filter((m) => {
  if (m.role !== 'assistant' || !Array.isArray(m.content)) return true;
  return !(m.content as any[]).some((p) => p.toolCallId === 'c-start');
});
await (missionStart as any).execute({ name: '起点已丢' }, { toolCallId: 'c-start', messages: msgs3 });
const lostRes: any = await (missionAccomplish as any).execute({ summary: 'x' }, { toolCallId: 'c-acc', messages: msgs3 });
check('起点丢失时不裁剪并提示', String(lostRes).includes('起点消息已不在上下文中') && lostRes.rawBulk.messagesRemoved === 0);
check('起点丢失后标记已清除', String(await (missionCancel as any).execute({}, {})).includes('没有进行中的任务段'));

// ── 7. 区间为空（start 与 accomplish 同一条 assistant 消息） ──
const msgs4: ModelMessage[] = [
  { role: 'user', content: '空区间' },
  {
    role: 'assistant',
    content: [toolCall('c-s', 'mission-start', { name: '空区间' }), toolCall('c-a', 'mission-accomplish', { summary: 'x' })],
  } as ModelMessage,
];
await (missionStart as any).execute({ name: '空区间' }, { toolCallId: 'c-s', messages: msgs4 });
const emptyRes: any = await (missionAccomplish as any).execute({ summary: 'x' }, { toolCallId: 'c-a', messages: msgs4 });
check('空区间不裁剪', emptyRes.rawBulk.messagesRemoved === 0 && msgs4.length === 2);

// ── 8. tool-cache 豁免 ──
toolCache.reset();
let missionCalls = 0;
const wrappedMission = toolCache.wrap<any>('mission-accomplish', async () => { missionCalls++; return 'ok'; });
await wrappedMission({ summary: 'a' }, {});
await wrappedMission({ summary: 'a' }, {});
check('mission-* 连续同参调用真实执行两次（未命中缓存）', missionCalls === 2);
let readCalls = 0;
const wrappedRead = toolCache.wrap<any>('read_file', async () => { readCalls++; return 'ok'; });
await wrappedRead({ filePath: 'a.ts' }, {});
await wrappedRead({ filePath: 'a.ts' }, {});
check('对照：普通工具连续同参调用命中缓存（仅执行一次）', readCalls === 1);
toolCache.reset();

// ── 9. 归档落盘 ──
const storeFile = path.join(getWorkspaceRoot(), 'sessions', TEST_SESSION, 'worklog', 'entries.json');
check('归档文件落盘', fs.existsSync(storeFile));
if (fs.existsSync(storeFile)) {
  const raw = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
  const w1 = (raw.entries ?? []).find((e: any) => e.id === 'W1');
  check('落盘含 W1 梗概', w1?.summary === SUMMARY);
  check('落盘含原文消息', JSON.stringify(w1?.archivedMessages ?? []).includes('文件1内容'));
}

// ── 清理 ──
try { fs.rmSync(path.join(getWorkspaceRoot(), 'sessions', TEST_SESSION), { recursive: true, force: true }); } catch { /* 忽略 */ }

let failed = 0;
for (const a of asserts) {
  console.log(`${a.ok ? '✅' : '❌'} ${a.name}`);
  if (!a.ok) failed++;
}
console.log(failed === 0 ? `\n全部通过（${asserts.length} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
