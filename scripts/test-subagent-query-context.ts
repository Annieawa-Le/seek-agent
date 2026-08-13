/**
 * test-subagent-query-context.ts — agent_query 携带子模型上下文验证
 *
 * 背景：queryChildAgent（agent_query 带 question 提问）旧实现构建消息时，
 * mission 模式完全没有子模型上下文（空 + question），clone 模式只带主模型
 * 消息——提问时子模型「失忆」。修复后与 executeChildAgent 对齐：
 *   clone 模式：主模型完整消息
 *   mission 模式：持久化对话历史（subagentContextStore 落盘），无历史回退 spawn 时的 context
 *   instructor 模式：instructor 独立消息历史
 * 最后追加 question。
 *
 * 运行：npx tsx scripts/test-subagent-query-context.ts
 */
import { buildQueryChildMessages } from '../src/tools/inner_skills/sub-agent/runner';
import { subagentContextStore } from '../src/tools/subagent-context-store';
import { setWorkspaceRoot, resetWorkspaceRoot } from '../src/workdir';
import type { SubAgentState } from '../src/tools/inner_skills/sub-agent/types';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-query-ctx-'));
setWorkspaceRoot(tmp);
subagentContextStore.setSessionId('test-sid');

const QUESTION = '你对当前方案有什么看法？';
const MAIN_MSGS = [
  { role: 'user' as const, content: '主模型消息1' },
  { role: 'assistant' as const, content: '主模型消息2' },
];

function mkAgent(partial: Partial<SubAgentState>): SubAgentState {
  return {
    name: 'test-agent',
    mode: 'mission',
    status: 'idle',
    tools: [],
    createdAt: Date.now(),
    ...partial,
  };
}

try {
  // ── 1. clone 模式：携带主模型消息 + question ──
  console.log('\n[1] clone 模式');
  const cloneAgent = mkAgent({ mode: 'clone' });
  const cloneMsgs = buildQueryChildMessages(cloneAgent, MAIN_MSGS, QUESTION);
  assert(cloneMsgs.length === 3, 'clone：主模型 2 条 + question 共 3 条', `实际 ${cloneMsgs.length}`);
  assert(cloneMsgs[0].role === 'user' && (cloneMsgs[0].content as string) === '主模型消息1', 'clone：首条为主模型消息');
  const lastMsg = cloneMsgs[cloneMsgs.length - 1];
  assert(lastMsg.role === 'user' && (lastMsg.content as string) === QUESTION, 'clone：末条为 question');

  // ── 2. mission 模式：有持久化历史 → 加载历史（未闭环 tool-call 构造 ToolResult 补上） + question ──
  const ctxName = 'ctx-worker';
  const closedCall = 'call-ok';
  const orphanCall = 'call-orphan';
  subagentContextStore.save(ctxName, {
    name: ctxName,
    mode: 'mission',
    tools: ['read_file'],
    context: 'spawn 上下文',
    messages: [
      { role: 'user', content: '上次的任务背景' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我读一下文件' },
          { type: 'tool-call', toolCallId: orphanCall, toolName: 'read_file', input: { filePath: 'a.ts' } },
          { type: 'tool-call', toolCallId: closedCall, toolName: 'read_file', input: { filePath: 'b.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: closedCall, toolName: 'read_file', output: { type: 'text', value: '内容' } }],
      },
      { role: 'assistant', content: '上次的结论' },
    ],
  });
  const ctxAgent = mkAgent({ name: ctxName, mode: 'mission', context: 'spawn 上下文' });
  const ctxMsgs = buildQueryChildMessages(ctxAgent, MAIN_MSGS, QUESTION);
  assert(ctxMsgs.length >= 4, 'mission：历史 4 条 + question ≥ 5 条', `实际 ${ctxMsgs.length}`);
  const firstUser = ctxMsgs.find((m) => m.role === 'user' && (m.content as string) === '上次的任务背景');
  assert(!!firstUser, 'mission：加载了持久化历史（首条 user 为上次背景）');
  const lastMsg2 = ctxMsgs[ctxMsgs.length - 1];
  assert(lastMsg2.role === 'user' && (lastMsg2.content as string) === QUESTION, 'mission：末条为 question');
  // 未闭环 tool-call：不再截断，保留 + 构造 ToolResult 占位（配对完整，不丢上下文）
  const orphanText = JSON.stringify(ctxMsgs);
  assert(orphanText.includes(orphanCall), 'mission：未闭环 tool-call 保留（不截断）');
  assert(orphanText.includes('[未完成] 工具调用被中断'), 'mission：为未闭环 tool-call 构造 ToolResult 占位');
  assert(orphanText.includes(closedCall), 'mission：闭环 tool-call 保留');
  assert(orphanText.includes('上次的结论'), 'mission：后续 assistant 消息保留');

  // ── 3. mission 模式：无历史但有 spawn context → 回退 context + question ──
  console.log('\n[3] mission + 无历史回退 context');
  const freshAgent = mkAgent({ mode: 'mission', context: '这是 spawn 时的任务背景' });
  const freshMsgs = buildQueryChildMessages(freshAgent, MAIN_MSGS, QUESTION);
  assert(freshMsgs.length === 2, 'mission：context + question 共 2 条', `实际 ${freshMsgs.length}`);
  assert(freshMsgs[0].role === 'user' && (freshMsgs[0].content as string) === '这是 spawn 时的任务背景', 'mission：回退到 spawn context');
  assert(freshMsgs[1].role === 'user' && (freshMsgs[1].content as string) === QUESTION, 'mission：末条为 question');

  // ── 4. mission 模式：无历史无 context → 仅 question（不崩溃） ──
  console.log('\n[4] mission + 无历史无 context');
  const bareAgent = mkAgent({ mode: 'mission' });
  const bareMsgs = buildQueryChildMessages(bareAgent, MAIN_MSGS, QUESTION);
  assert(bareMsgs.length === 1 && (bareMsgs[0].content as string) === QUESTION, 'mission：仅 question');

  // ── 5. instructor 模式：有 instructorMessages → 携带 + question ──
  console.log('\n[5] instructor + 独立历史');
  const instAgent = mkAgent({
    mode: 'instructor',
    instructorMessages: [
      { role: 'user', content: '主模型输出：完成了 A' },
      { role: 'assistant', content: '建议：接着做 B' },
    ],
  });
  const instMsgs = buildQueryChildMessages(instAgent, MAIN_MSGS, QUESTION);
  assert(instMsgs.length === 3, 'instructor：历史 2 条 + question 共 3 条', `实际 ${instMsgs.length}`);
  assert((instMsgs[0].content as string) === '主模型输出：完成了 A', 'instructor：携带历史首条');
  assert((instMsgs[1].content as string) === '建议：接着做 B', 'instructor：携带历史次条');
  assert((instMsgs[2].content as string) === QUESTION, 'instructor：末条为 question');

  // ── 6. instructor 模式：无历史 → 仅 question ──
  console.log('\n[6] instructor + 无历史');
  const bareInst = mkAgent({ mode: 'instructor' });
  const bareInstMsgs = buildQueryChildMessages(bareInst, MAIN_MSGS, QUESTION);
  assert(bareInstMsgs.length === 1 && (bareInstMsgs[0].content as string) === QUESTION, 'instructor：仅 question');


  // ── 7. cleanPersistedMessages 独立验证（a_submission 场景 + 孤立 result） ──
  console.log('\n[7] cleanPersistedMessages 配对修复');
  const { cleanPersistedMessages } = await import('../src/tools/subagent-context-store');
  // a_submission 残留：assistant 含 read-call + submit-call，只有 read result → submit 应被补占位 result
  const raw = [
    { role: 'user', content: '任务' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '先读文件' },
        { type: 'tool-call', toolCallId: 'call-read', toolName: 'read_file', input: { filePath: 'a.ts' } },
        { type: 'tool-call', toolCallId: 'call-submit', toolName: 'a_submission', input: { summary: '完成', details: 'd' } },
      ],
    },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-read', toolName: 'read_file', output: { type: 'text', value: '内容' } }] },
  ];
  const cleaned = cleanPersistedMessages(raw);
  const cJson = JSON.stringify(cleaned);
  assert(cJson.includes('call-submit'), 'a_submission tool-call 保留（不截断）');
  assert(cJson.includes('[未完成] 工具调用被中断'), 'a_submission 补 ToolResult 占位');
  assert(cJson.includes('call-read'), 'read tool-call 保留');
  assert(cJson.includes('call-read') && cJson.includes('内容'), 'read result 保留');
  // 孤立 result（无对应 call）应被移除
  const orphanRaw = [
    { role: 'user', content: '任务' },
    { role: 'assistant', content: '好的' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-ghost', toolName: 'read_file', output: { type: 'text', value: 'x' } }] },
  ];
  const orphanCleaned = cleanPersistedMessages(orphanRaw);
  const oJson = JSON.stringify(orphanCleaned);
  assert(!oJson.includes('call-ghost'), '孤立 tool-result 被移除');
  assert(oJson.includes('好的'), '正常消息保留');
  // 清理持久化上下文
  subagentContextStore.remove(ctxName);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
} finally {
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
}


