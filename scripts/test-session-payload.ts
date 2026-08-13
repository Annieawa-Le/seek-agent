/**
 * 验证 session 附加字段 payloads（每次发给模型的完整 payload 记录）：
 * 1. stripToolExecutes(filterToolsForActiveModes(tools)) 可 JSON 序列化（tools schema 能落盘）
 * 2. recordPayload 自动打时间戳、messages 深拷贝快照、上限截断
 * 3. payload 记录 JSON round-trip 后字段完整（供 WebUI「记忆」面板读取）
 */
import { CLIAAgent } from '../src/agent';
import { tools, stripToolExecutes } from '../src/tools';
import { filterToolsForActiveModes } from '../src/modes/registry';

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

// ── 1. tools schema 可序列化（autoSaveSession 落盘前提） ──
console.log('\n[1] tools schema 序列化');
const payloadTools = stripToolExecutes(filterToolsForActiveModes(tools));
const toolNames = Object.keys(payloadTools);
let toolsJson = '';
try {
  toolsJson = JSON.stringify(payloadTools);
  assert(true, `JSON.stringify 成功，${toolNames.length} 个工具，约 ${(toolsJson.length / 1024).toFixed(0)} KB`);
} catch (e: any) {
  assert(false, 'JSON.stringify 失败', e.message);
}
assert(toolNames.includes('read_file'), '包含核心工具 read_file');
assert(toolsJson.length > 1000, 'tools schema 非空');
const allStripped = Object.values(payloadTools).every((t: any) => typeof t.execute === 'undefined');
assert(allStripped, '所有工具已剥离 execute（无函数）');

// ── 2. recordPayload 行为 ──
console.log('\n[2] recordPayload（自动 ts / 深拷贝快照 / 上限截断）');
const agent = new CLIAAgent({} as any, 'test-system-prompt');
const mkMsg = (i: number) => ({ role: 'user' as const, content: `msg-${i}` });
const base = [mkMsg(0), mkMsg(1)];
// 模拟真实调用点（agent.ts streamText 处）：messages 深拷贝快照后传入
(agent as any).recordPayload({
  system: 'sys',
  messages: JSON.parse(JSON.stringify(base)),
  tools: payloadTools,
  thinking: true,
});
let h1 = agent.getPayloadHistory();
assert(h1.length === 1, '记录 1 条');
assert(typeof h1[0].ts === 'string' && h1[0].ts.length > 0, '自动打时间戳');
assert(h1[0].system === 'sys' && h1[0].thinking === true, 'system/thinking 字段正确');
assert(h1[0].messages.length === 2, 'messages 完整记录');
// 深拷贝快照：发送后 push 新消息不应污染历史记录
base.push(mkMsg(99));
h1 = agent.getPayloadHistory();
assert(h1[0].messages.length === 2, '深拷贝快照：后续 push 不污染历史');
// 上限截断：总数 1+8=9 条，slice(-8) 保留最后 8 条
for (let i = 0; i < 8; i++) {
  (agent as any).recordPayload({ system: `sys-${i}`, messages: [mkMsg(i)], tools: payloadTools, thinking: false });
}
const h2 = agent.getPayloadHistory();
assert(h2.length === 8, `上限截断到 8 条（实际 ${h2.length}）`);
assert(h2[0].system === 'sys-0', '淘汰最旧记录');
assert(h2[7].system === 'sys-7', '保留最新记录');

// ── 3. JSON round-trip（模拟 autoSaveSession 写盘 → WebUI 读盘） ──
console.log('\n[3] payload 记录 JSON round-trip');
const roundTrip = JSON.parse(JSON.stringify(h2));
assert(Array.isArray(roundTrip) && roundTrip.length === 8, 'round-trip 长度一致');
const last = roundTrip[7];
assert(
  typeof last.system === 'string' &&
  Array.isArray(last.messages) &&
  typeof last.tools === 'object' &&
  typeof last.thinking === 'boolean' &&
  typeof last.ts === 'string',
  '字段齐全（system/messages/tools/thinking/ts）',
);
assert(last.messages.length === 1 && last.messages[0].content === 'msg-7', 'messages 内容完整');
assert(Object.keys(last.tools).length === toolNames.length, 'tools schema 完整保留');

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);


