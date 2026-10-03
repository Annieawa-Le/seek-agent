/**
 * 回归：孤立 tool-call / tool-result 的自动修复
 *
 * 背景：工具渲染抛错会让 assistant 的 tool-call 入栈却没有 tool-result，
 * provider 收到畸形消息直接 400，且重试无意义（消息没变），会话从此报废。
 * message_managing 的 hook 现在会在发请求前补齐/剔除孤立 part。
 */
import { createMessageHook } from '../src/message_managing'
import type { ModelMessage } from 'ai'

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

const hook = createMessageHook()

function callIds(msgs: ModelMessage[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content) if (p.type === 'tool-call') out.push((p as any).toolCallId)
  }
  return out
}
function resultIds(msgs: ModelMessage[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content) if (p.type === 'tool-result') out.push((p as any).toolCallId)
  }
  return out
}
function isPaired(msgs: ModelMessage[]): boolean {
  const c = new Set(callIds(msgs))
  const r = new Set(resultIds(msgs))
  return c.size === r.size && [...c].every((id) => r.has(id)) && [...r].every((id) => c.has(id))
}

// ── 1. 正常消息不受影响 ──
console.log('\n1. 配对完好的消息')
{
  const msgs: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'style_list', input: {} }] } as any,
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'style_list', output: { type: 'text', value: 'ok' } }] } as any,
  ]
  const out = hook(msgs)
  // 注：hook 会额外注入 [工作记忆] user 消息，故不比较条数，只验证配对完好
  check('配对仍然完好', isPaired(out))
  check('未补占位 result', out.filter((m) => m.role === 'tool').length === msgs.filter((m) => m.role === 'tool').length)
}

// ── 2. 孤立 tool-call → 补占位 result ──
console.log('\n2. 孤立 tool-call（系统崩溃留下的畸形会话）')
{
  const msgs: ModelMessage[] = [
    { role: 'user', content: '泊松方程？' },
    { role: 'assistant', content: [
      { type: 'text', text: '我去查风格库' },
      { type: 'tool-call', toolCallId: 'call_orphan', toolName: 'style_list', input: {} },
    ] } as any,
  ]
  const out = hook(msgs)
  check('已补齐配对', isPaired(out))
  check('补出了 tool-result', resultIds(out).includes('call_orphan'))
  const placeholder = out.find((m) => m.role === 'tool') as any
  check('占位文本正确', String(placeholder?.content?.[0]?.output?.value).includes('未返回结果'))
}

// ── 3. 孤立 tool-result → 剔除 ──
console.log('\n3. 孤立 tool-result（有 result 无 call）')
{
  const msgs: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'ghost', toolName: 'x', output: { type: 'text', value: 'y' } }] } as any,
    { role: 'user', content: 'next' },
  ]
  const out = hook(msgs)
  check('已剔除孤立 result', !resultIds(out).includes('ghost'))
  check('其余消息保留', out.some((m) => m.role === 'user' && m.content === 'next'))
}

// ── 4. 真实故障会话的形态（多 tool-call 部分缺失） ──
console.log('\n4. 一条 assistant 多个 tool-call，只回了一半')
{
  const msgs: ModelMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'a', toolName: 't1', input: {} },
      { type: 'tool-call', toolCallId: 'b', toolName: 't2', input: {} },
    ] } as any,
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 't1', output: { type: 'text', value: 'ok' } }] } as any,
  ]
  const out = hook(msgs)
  check('已补齐 b', isPaired(out))
  check('原有 a 结果未被破坏', resultIds(out).includes('a'))
}

// ── 5. 用真实损坏会话验证 ──
console.log('\n5. 真实损坏会话 session-y6xg-f4ie-dqn5')
{
  const fs = await import('node:fs')
  const f = 'sessions/session-y6xg-f4ie-dqn5/session.json'
  if (fs.existsSync(f)) {
    const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
    const raw = data.agentMessages
    check('修复前确有孤立的 tool-call', !isPaired(raw))
    const out = hook(raw)
    check('修复后配对完整', isPaired(out))
  } else {
    console.log('  (会话文件不存在，跳过)')
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
