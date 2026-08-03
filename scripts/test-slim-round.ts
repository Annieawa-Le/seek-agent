/**
 * 验证分层保真（slimOldestRound）：
 *  - 只针对最旧一轮（rounds[0]）处理：占比超阈值 → 幂等工具结果简化为"已遗忘，请重新读取"
 *  - 非幂等工具结果保留
 *  - 最旧轮占比未超阈值 → 返回 null（直接走移除-梗概路径）
 *  - 消息结构与 tool-call/tool-result 配对保持完整
 */
import { slimOldestRound, roundRatioThreshold, estimateMessagesTokens } from '../src/context-compactor';
import type { ModelMessage } from 'ai';

const asserts: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { asserts.push({ name, ok }); }

function mkToolRound(user: string, idx: number, readSize: number, cmdOutput: string): ModelMessage[] {
  const msgs: ModelMessage[] = [{ role: 'user', content: user }];
  msgs.push({
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: `call-${idx}a`, toolName: 'read_file', input: { filePath: `f${idx}.ts` } },
      { type: 'tool-call', toolCallId: `call-${idx}b`, toolName: 'execute_command', input: { command: 'echo hi' } },
    ],
  } as ModelMessage);
  msgs.push({
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: `call-${idx}a`, toolName: 'read_file', output: { type: 'text', value: '文件内容'.repeat(readSize) } },
      { type: 'tool-result', toolCallId: `call-${idx}b`, toolName: 'execute_command', output: { type: 'text', value: cmdOutput } },
    ],
  } as ModelMessage);
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: `回复：${user}` }] } as ModelMessage);
  return msgs;
}

// ── 1. 配置 ──
const oldRatio = process.env.ROUND_RATIO_THRESHOLD;
delete process.env.ROUND_RATIO_THRESHOLD;
check('默认占比阈值 0.5', roundRatioThreshold() === 0.5);
process.env.ROUND_RATIO_THRESHOLD = '0.3';
check('env 覆盖占比阈值', roundRatioThreshold() === 0.3);
delete process.env.ROUND_RATIO_THRESHOLD;
if (oldRatio !== undefined) process.env.ROUND_RATIO_THRESHOLD = oldRatio;

// ── 2. 最旧轮占比超阈值 → 幂等简化、非幂等保留 ──
// 最旧轮（大轮）：read_file 结果很大（占大头），另一轮很小
const bigRound = mkToolRound('读了很多文件', 1, 500, 'ls 输出内容'.repeat(3));
const smallRound = mkToolRound('小问题', 2, 5, 'hi');
const msgs: ModelMessage[] = [...bigRound, ...smallRound];
check('最旧轮占比确实超 50%', (() => {
  const total = estimateMessagesTokens(msgs);
  const oldest = estimateMessagesTokens(bigRound);
  return oldest / total > 0.5;
})());

const slimmed = slimOldestRound(msgs);
check('slimOldestRound 返回新列表', slimmed !== null);
if (slimmed) {
  check('消息条数不变', slimmed.length === msgs.length);
  const toolMsg = slimmed.find((m) => m.role === 'tool' && Array.isArray(m.content));
  const parts = (toolMsg?.content as Array<{ toolName?: string; output?: { value?: string } }>) ?? [];
  const readPart = parts.find((p) => p.toolName === 'read_file');
  const cmdPart = parts.find((p) => p.toolName === 'execute_command');
  check('幂等 read_file 结果已简化', readPart?.output?.value.includes('已遗忘，请重新读取'));
  check('非幂等 execute_command 结果保留', cmdPart?.output?.value === 'ls 输出内容'.repeat(3));
  check('toolCallId 配对保留', parts.every((p) => typeof (p as any).toolCallId === 'string'));
  const totalAfter = estimateMessagesTokens(slimmed);
  check('瘦身后 token 显著下降', totalAfter < estimateMessagesTokens(msgs));
}

// ── 3. 最旧轮占比未超阈值 → 返回 null（走移除-梗概路径） ──
const even1 = mkToolRound('轮一', 1, 100, 'x'.repeat(500));
const even2 = mkToolRound('轮二', 2, 100, 'x'.repeat(500));
check('最旧轮占比不超阈值时返回 null', slimOldestRound([...even1, ...even2]) === null);

// ── 3b. 最旧轮小、后续轮大 → 不瘦身最旧轮（交给移除-梗概） ──
const smallFirst = mkToolRound('小轮在前', 1, 5, 'hi');
const bigAfter = mkToolRound('大轮在后', 2, 600, 'x'.repeat(10));
const mixedMsgs: ModelMessage[] = [...smallFirst, ...bigAfter];
check('最旧轮占比不超阈值时返回 null（即使后续轮很大）', slimOldestRound(mixedMsgs) === null);

// ── 4. 无幂等工具可简化（全是 execute_command）→ 返回 null ──
const allCmd: ModelMessage[] = [
  { role: 'user', content: '跑命令' },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'call-c', toolName: 'execute_command', input: { command: 'dir' } }],
  } as ModelMessage,
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call-c', toolName: 'execute_command', output: { type: 'text', value: '大输出'.repeat(500) } }],
  } as ModelMessage,
];
check('无可简化工具时返回 null', slimOldestRound(allCmd) === null);

// ── 5. 重复调用幂等（第二次无新效果） ──
const slimmed2 = slimOldestRound(slimmed ?? msgs);
check('二次瘦身返回 null（已无幂等可简化）', slimmed2 === null || estimateMessagesTokens(slimmed2) === estimateMessagesTokens(slimmed ?? []));

let failed = 0;
for (const a of asserts) {
  console.log(`${a.ok ? 'PASS' : 'FAIL'} ${a.name}`);
  if (!a.ok) failed++;
}
console.log(failed === 0 ? `\n全部通过（${asserts.length} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

