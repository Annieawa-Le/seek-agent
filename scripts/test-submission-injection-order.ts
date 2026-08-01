/**
 * test-submission-injection-order.ts — 子模型提交注入时序回归测试
 *
 * 背景：主模型用 agent_query(waitForCompletion) 等待子模型时，旧实现会在
 * executeToolCalls 的 await 挂起期间直接把 subagent_submission 消息对插入
 * messages，导致 agent_query 的 tool-result 被挤到注入对之后 —— 两个连续
 * tool 消息、tool-result 与 assistant tool-call 失配，上游以 400
 * invalid_request_error 拒绝（Error from provider (Console Go): Upstream request failed）。
 *
 * 修复：注入统一收敛到安全点（processRound 开头 / aiInteractionLoop 顶部 /
 * executeToolCalls 末尾），onSubAgentSubmission 只负责空闲时触发新一轮。
 * 本测试验证：
 *   1) manager pending 队列行为（queue/drain/hasPendingInjections）
 *   2) 消息序列合法性检查能识别旧行为的乱序
 *   3) 模拟新时序（工具结果落盘后注入）产生合法消息序列
 *
 * 运行：npx tsx scripts/test-submission-injection-order.ts
 */
import {
  queueSubmissionInjection,
  drainPendingInjections,
  hasPendingInjections,
} from '../src/tools/inner_skills/sub-agent/manager';

import { tools } from '../src/tools/index';
let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// ── 消息构造辅助 ──
const assistantToolCall = (toolCallId: string, toolName: string) => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
});
const toolResult = (toolCallId: string, toolName: string, value = 'ok') => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value } }],
});
const assistantText = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

/**
 * 校验消息序列是否符合 OpenAI 兼容规则：
 * 每条 tool 消息必须紧跟在包含其 toolCallId 的 assistant tool-call 之后
 * （最近一条 assistant 消息必须含该 toolCallId，中间不能再有 assistant）。
 * 乱序（如 tool-result 与其 tool-call 之间插入了另一对 assistant+tool）→ 非法。
 */
function isValidMessageSequence(msgs: any[]): boolean {
  let lastAssistantHasCall: { ids: Set<string> } | null = null;
  for (const m of msgs) {
    if (m.role === 'assistant') {
      const ids = new Set<string>();
      for (const p of m.content ?? []) {
        if (p.type === 'tool-call') ids.add(p.toolCallId);
      }
      lastAssistantHasCall = { ids };
      continue;
    }
    if (m.role === 'tool') {
      if (!lastAssistantHasCall) return false; // tool 消息前没有 assistant
      const id = m.content?.[0]?.toolCallId;
      if (!id || !lastAssistantHasCall.ids.has(id)) return false; // 与最近 assistant 失配
      continue;
    }
    // user / system 消息不影响配对关系
  }
  return true;
}

console.log('1) manager pending 队列行为');
queueSubmissionInjection('sub-1', { summary: '完成', details: '17 项全过' });
assert('hasPendingInjections() 为 true', hasPendingInjections());
const pending = drainPendingInjections();
assert('drain 返回 1 条且名字正确', pending.length === 1 && pending[0].name === 'sub-1');
assert('drain 后 pending 为空', !hasPendingInjections());
assert('重复 drain 幂等（空）', drainPendingInjections().length === 0);

console.log('2) 消息序列合法性检查（识别旧行为乱序）');
// 旧行为：注入对插在 assistant(tool-call agent_query) 与 tool(agent_query result) 之间
const oldSequence = [
  assistantText('我先派活并等待结果'),
  assistantToolCall('call-agent-query', 'agent_query'),
  assistantToolCall('call-sub', 'subagent_submission'), // 注入对插入
  toolResult('call-sub', 'subagent_submission'),
  toolResult('call-agent-query', 'agent_query'),        // 结果被挤到最后 → 乱序
];
assert('旧行为乱序被检测为非法', !isValidMessageSequence(oldSequence), JSON.stringify(oldSequence.map(m => m.content?.[0]?.type)));

// 新行为：工具结果全部落盘后才注入
const newSequence = [
  assistantText('我先派活并等待结果'),
  assistantToolCall('call-agent-query', 'agent_query'),
  toolResult('call-agent-query', 'agent_query'),
  assistantToolCall('call-sub', 'subagent_submission'),
  toolResult('call-sub', 'subagent_submission'),
];
assert('新行为（安全点注入）序列合法', isValidMessageSequence(newSequence));

// 正常单工具对也合法（对照组）
const normalSequence = [
  assistantText('正常工具调用'),
  assistantToolCall('call-read', 'read_file'),
  toolResult('call-read', 'read_file'),
  assistantText('回复'),
];
assert('正常工具对序列合法', isValidMessageSequence(normalSequence));

console.log('3) 模拟新注入时序（user 消息注入，不再构造 tool 对）');
/**
 * 模拟 executeToolCalls 挂起期间子模型完成：
 *  - 旧实现：queueSubmissionInjection → submissionListener 立即注入 tool 对（乱序 + 伪造 toolCallId）
 *  - 新实现：listener 只入队；注入推迟到安全点，且以 user 消息注入
 *    （上游 Console Go 校验 tool_call_id 必须为自己生成，伪造 id 的 tool 对会被 400 拒绝）
 */
function simulateSafeInjection(): any[] {
  const messages: any[] = [];
  // 主模型本轮已返回 tool-call（agent_query 等待子模型）
  messages.push(assistantToolCall('call-agent-query', 'agent_query'));
  // 挂起期间子模型完成：仅入队，不注入
  queueSubmissionInjection('sub-1', { summary: '完成', details: '详情...' });
  // agent_query 工具恢复，结果落盘
  messages.push(toolResult('call-agent-query', 'agent_query'));
  // executeToolCalls 末尾安全点：统一注入（user 消息）
  for (const p of drainPendingInjections()) {
    messages.push({ role: 'user', content: `【${p.name} 提交工作结果】概要: ${p.payload.summary}` });
  }
  return messages;
}
const simulated = simulateSafeInjection();
assert('安全点注入后无伪造 tool-call（user 消息注入）', simulated.every(m => m.role !== 'assistant' || !m.content?.some((p: any) => p.type === 'tool-call' && p.toolName === 'subagent_submission')));
assert('注入内容以【开头（系统过滤约定）', typeof simulated.at(-1)?.content === 'string' && simulated.at(-1)!.content.startsWith('【'));

// 空闲时由 processRound 开头注入（messages 末尾是上一轮完整回复）
const idleSequence = [
  assistantText('上一轮派活完成'),
  ...(() => {
    const list: any[] = [];
    for (const p of drainPendingInjections()) {
      list.push({ role: 'user', content: `【${p.name} 提交工作结果】概要: ${p.payload.summary}` });
    }
    return list;
  })(),
];
assert('空闲时轮首注入为 user 消息', idleSequence.every(m => m.role === 'assistant' || m.role === 'user'));
assert('drain 已清空', !hasPendingInjections());

console.log('4) 注入不再依赖工具注册（避免伪造 tool-call）');
assert('主模型 tools 不含 subagent_submission（注入已改 user 消息）', !('subagent_submission' in tools));
assert('主模型 tools 含 a_submission', 'a_submission' in tools);
assert('主模型 tools 含 agent_query', 'agent_query' in tools);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);








