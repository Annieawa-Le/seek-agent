/**
 * test-agent-query-question.ts — agent_query 改造验证
 *
 * 改造内容（2026-08-14）：
 *   1. agent_query 的 question 字段改为必填（不再支持无参状态查询 / waitForCompletion）
 *   2. 调用时安全截停子模型的当前执行：abort 正在运行的流 + 等待 executionPromise 完全结束
 *      （旧执行在 finally 里保存上下文本地化，避免并发写）——抽为 abortAndWaitChildExecution 纯函数
 *   3. 问题以 user 消息注入子模型对话流（buildQueryChildMessages 追加为末条 user 消息）
 *   4. 带工具短循环取子模型返回的第一条文本作为工具结果
 *
 * 本测试不触发真实 LLM：只验证 schema 必填、截停纯函数、execute 错误路径、question 注入。
 *
 * 运行：npx tsx scripts/test-agent-query-question.ts
 */
import { abortAndWaitChildExecution, buildQueryChildMessages } from '../src/tools/inner_skills/sub-agent/runner';
import { subAgentManager } from '../src/tools/inner_skills/sub-agent/manager';
import type { SubAgentState } from '../src/tools/inner_skills/sub-agent/types';

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
  // ── 1. agent_query 工具 schema：question 必填、waitForCompletion 移除 ──
  console.log('\n[1] agent_query 工具 schema');
  const { tools } = await import('../src/tools/index');
  const schema = (tools['agent_query'] as any).inputSchema;
  assert(!!schema, 'agent_query 工具已注册且有 inputSchema');

  const noQuestion = schema.safeParse({ name: 'xxx' });
  assert(!noQuestion.success, '缺 question → schema 校验失败（question 必填）');

  const withQuestion = schema.safeParse({ name: 'xxx', question: '你对方案怎么看？' });
  assert(withQuestion.success, '带 name + question → schema 校验通过');

  const shape = schema.shape ?? {};
  assert(!('waitForCompletion' in shape), 'waitForCompletion 字段已移除');
  assert(shape.question && !shape.question.isOptional?.(), 'question 字段为非 optional');

  // ── 2. execute 错误路径：未找到子模型 ──
  console.log('\n[2] agent_query execute 错误路径');
  const result = await tools['agent_query'].execute({ name: '不存在的子模型', question: 'q' }, { messages: [] } as any);
  assert(typeof result === 'string' && result.includes('未找到'), '未找到子模型时返回提示', String(result));

  // ── 3. abortAndWaitChildExecution：running 子模型被截停并等待收尾 ──
  console.log('\n[3] 安全截停纯函数');
  // 3a. running agent：两个 controller 都被 abort，executionPromise 被 await 到完成
  let settled = false;
  const ac = new AbortController();
  const ic = new AbortController();
  const ep = new Promise<void>((resolve) => setTimeout(() => { settled = true; resolve(); }, 20));
  const runningAgent = mkAgent({ status: 'running', abortController: ac, instructorAbortController: ic, executionPromise: ep });
  await abortAndWaitChildExecution(runningAgent);
  assert(ac.signal.aborted, 'abortController 被 abort（mission/clone 流）');
  assert(ic.signal.aborted, 'instructorAbortController 被 abort（instructor 流）');
  assert(settled, 'executionPromise 被 await 到完成（等待旧执行收尾保存上下文）');

  // 3b. executionPromise reject 时不抛出（旧执行被截停标记 error 是预期路径）
  let threw = false;
  const rejectEp = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('已停止')), 5));
  const rejectAgent = mkAgent({ status: 'running', abortController: new AbortController(), executionPromise: rejectEp });
  try {
    await abortAndWaitChildExecution(rejectAgent);
  } catch {
    threw = true;
  }
  assert(!threw, 'executionPromise reject 被吞掉（不抛出）');

  // 3c. 无 controller / 无 executionPromise（idle/done 子模型）→ 不报错
  let threw2 = false;
  try {
    await abortAndWaitChildExecution(mkAgent({ status: 'done' }));
  } catch {
    threw2 = true;
  }
  assert(!threw2, 'idle/done 子模型截停不报错（无 controller 时无害）');

  // 3d. 幂等：截停后再次截停（executionPromise 已被清）不报错
  let threw3 = false;
  try {
    await abortAndWaitChildExecution(runningAgent);
  } catch {
    threw3 = true;
  }
  assert(!threw3, '重复截停不报错（幂等）');

  // ── 4. question 以 user 消息注入（buildQueryChildMessages 语义） ──
  console.log('\n[4] question 注入为末条 user 消息');
  const QUESTION = '这个改动会影响哪些文件？';
  const MAIN_MSGS = [
    { role: 'user' as const, content: '主模型消息1' },
    { role: 'assistant' as const, content: '主模型消息2' },
  ];
  const cloneMsgs = buildQueryChildMessages(mkAgent({ mode: 'clone' }), MAIN_MSGS, QUESTION);
  const last = cloneMsgs[cloneMsgs.length - 1];
  assert(last.role === 'user' && (last.content as string) === QUESTION, 'clone：question 作为末条 user 消息注入');
  assert(cloneMsgs.length === MAIN_MSGS.length + 1, 'clone：主模型消息 + question 完整保留', `实际 ${cloneMsgs.length}`);

  // 注入位置不覆盖子模型既有上下文（mission 有历史时历史在前、question 在末）
  const histMsgs = [
    { role: 'user', content: '上次的任务背景' },
    { role: 'assistant', content: '上次的结论' },
  ];
  // 直接构造：mission 无持久化历史时回退 context，question 仍在末
  const freshMsgs = buildQueryChildMessages(mkAgent({ mode: 'mission', context: 'spawn 时的背景' }), MAIN_MSGS, QUESTION);
  assert(freshMsgs.length === 2, 'mission：context + question 共 2 条', `实际 ${freshMsgs.length}`);
  assert((freshMsgs[0].content as string) === 'spawn 时的背景', 'mission：context 在 question 之前');
  assert((freshMsgs[1].content as string) === QUESTION, 'mission：question 为末条 user 消息');

  // ── 5. subAgentManager 状态往返（查询前后状态标记不被截停逻辑破坏） ──
  console.log('\n[5] manager 状态一致性');
  subAgentManager.spawn({ mode: 'mission', name: 'query-ctx-check', tools: [] });
  subAgentManager.updateStatus('query-ctx-check', 'running');
  const qAgent = subAgentManager.get('query-ctx-check')!;
  qAgent.abortController = new AbortController();
  await abortAndWaitChildExecution(qAgent);
  assert(qAgent.abortController.signal.aborted, 'manager 中 running 子模型可被安全截停');
  subAgentManager.updateStatus('query-ctx-check', 'done');
  subAgentManager.fire('query-ctx-check');
  assert(!subAgentManager.get('query-ctx-check'), '清理：子模型已销毁');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
} catch (e: any) {
  console.error(`\n❌ 测试脚本异常: ${e?.stack || e}`);
  process.exit(1);
}
