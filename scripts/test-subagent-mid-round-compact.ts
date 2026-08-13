/**
 * test-subagent-mid-round-compact.ts — 子 Agent 上下文中途强制折叠验证
 *
 * 背景：旧实现只在每轮 streamText 结束后按真实 usage.inputTokens 检查压缩；
 * 若一轮内工具结果把上下文撑得很大，轮中不折叠。修复后：
 *   1. shouldCompactChildContext —— 纯函数：估算 token 超触发线且 ≥2 轮 → 需要折叠
 *   2. maybeCompactChildContext —— 对话进行中（工具结果累积）实时压缩，
 *      不等当前轮次结束；仅一轮时跳过（至少保留一轮真实对话）
 *
 * 运行：npx tsx scripts/test-subagent-mid-round-compact.ts
 */
import { shouldCompactChildContext, maybeCompactChildContext } from '../src/tools/inner_skills/sub-agent/runner';
import { subagentContextStore } from '../src/tools/subagent-context-store';
import { SubagentWorklogStore } from '../src/tools/subagent-worklog-store';
import { setWorkspaceRoot, resetWorkspaceRoot } from '../src/workdir';
import type { SubAgentState } from '../src/tools/inner_skills/sub-agent/types';
import type { ModelMessage } from 'ai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 用小触发线方便构造超限上下文
process.env.MAX_CONTEXT_TOKENS = '1000';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-mid-compact-'));
setWorkspaceRoot(tmp);
subagentContextStore.setSessionId('test-sid');

const bigText = 'x'.repeat(3000); // ~900 token 估算
const mockSummarize = async () => ({
  title: '中途折叠测试',
  summary: '【标题】中途折叠测试\n【用户意图】折叠了最旧一轮\n【关键决策】\n【文件改动】\n【待办】\n【取回指引】work_recall 查看原文',
});

function mkAgent(name: string): SubAgentState {
  return { name, mode: 'mission', status: 'idle', tools: [], createdAt: Date.now() };
}

try {
  // ── 1. shouldCompactChildContext 纯函数 ──
  console.log('\n[1] shouldCompactChildContext');
  const small: ModelMessage[] = [
    { role: 'user', content: '小任务' },
    { role: 'assistant', content: '好' },
  ];
  assert(!shouldCompactChildContext(small), '小上下文不触发');

  const twoBigRounds: ModelMessage[] = [
    { role: 'user', content: `任务开始 ${bigText}` },
    { role: 'assistant', content: '我先读文件' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: bigText } }] },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '好' },
  ];
  assert(shouldCompactChildContext(twoBigRounds), '两轮 + 超线 → 需要折叠');

  const oneBigRound: ModelMessage[] = [
    { role: 'user', content: `唯一一轮 ${bigText}` },
    { role: 'assistant', content: '好' },
  ];
  assert(!shouldCompactChildContext(oneBigRound), '仅一轮即使超线也不折叠（保留至少一轮）');

  // ── 2. maybeCompactChildContext：中途折叠（估算路径） ──
  console.log('\n[2] maybeCompactChildContext 中途折叠');
  const agent = mkAgent('mid-worker');
  const store = new SubagentWorklogStore();
  store.setSessionId('test-sid');
  store.setActiveAgent(agent.name);

  const childMessages: ModelMessage[] = [
    { role: 'user', content: `任务开始 ${bigText}` },
    { role: 'assistant', content: '我先读文件' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: bigText } }] },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '好' },
  ];
  const before = childMessages.length;
  const folded = await maybeCompactChildContext(agent, childMessages, undefined, mockSummarize);
  assert(folded === true, '中途折叠发生（返回 true）');
  assert(childMessages.length < before, '消息条数减少', `前 ${before} → 后 ${childMessages.length}`);
  const headText = typeof childMessages[0].content === 'string' ? childMessages[0].content : '';
  assert(headText.startsWith('[Worklog#W1]'), '头部插入 [Worklog#W1]', headText.slice(0, 40));
  const all = JSON.stringify(childMessages);
  assert(all.includes('继续'), '当前轮保留');
  const w1 = store.get('W1');
  assert(!!w1 && w1.title === '中途折叠测试', 'Worklog 已落盘（title 正确）');
  assert(!all.includes('我先读文件'), '最旧一轮已被移除');

  // ── 3. 仅一轮时不折叠 ──
  console.log('\n[3] 仅一轮跳过');
  const singleRound: ModelMessage[] = [
    { role: 'user', content: `唯一一轮 ${bigText}` },
    { role: 'assistant', content: '好' },
  ];
  const foldedSingle = await maybeCompactChildContext(agent, singleRound, undefined, mockSummarize);
  assert(foldedSingle === false, '仅一轮不折叠');
  assert(singleRound.length === 2, '消息未被修改');

  // ── 4. 不超线不折叠 ──
  console.log('\n[4] 不超线跳过');
  const smallMsgs: ModelMessage[] = [
    { role: 'user', content: '小任务' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '完成' },
  ];
  const foldedSmall = await maybeCompactChildContext(agent, smallMsgs, undefined, mockSummarize);
  assert(foldedSmall === false, '不超线不折叠');
  assert(smallMsgs.length === 4, '消息未被修改');

  // ── 5. 轮末真实 token 路径（realInputTokens 超线但估算不超） ──
  console.log('\n[5] 轮末 realInputTokens 路径');
  const realistic: ModelMessage[] = [
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '继续读' },
    { role: 'assistant', content: '正在读' },
  ];
  const foldedReal = await maybeCompactChildContext(agent, realistic, 5000, mockSummarize);
  assert(foldedReal === true, 'realInputTokens 超线触发折叠');
  const realHead = typeof realistic[0].content === 'string' ? realistic[0].content : '';
  assert(realHead.startsWith('[Worklog#W2]'), '头部插入 [Worklog#W2]', realHead.slice(0, 40));

  // 清理
  subagentContextStore.remove(agent.name);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
} finally {
  delete process.env.MAX_CONTEXT_TOKENS;
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
}




