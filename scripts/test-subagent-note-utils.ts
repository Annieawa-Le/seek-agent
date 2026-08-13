/**
 * test-subagent-note-utils.ts — 子 Agent 便条窗体纯函数验证
 *
 * 验证 SubagentNotePanel 的两个核心转换：
 *   1. toNoteMessages：消息流 → 主消息区一致的 DisplayMessage（工具并入 agent 气泡）
 *   2. buildSessionFile：消息流 → json-session 文件（未完成的工具调用补 toolResult）
 */
import { toNoteMessages, buildSessionFile } from '../electron/renderer/src/utils/subagent-note-utils';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}`); }
}

console.log('1) toNoteMessages 基本渲染');
{
  const stream = [
    { role: 'user' as const, content: '任务：分析代码', ts: 1 },
    { role: 'assistant' as const, content: '开始分析', ts: 2 },
    { role: 'tool' as const, content: '', toolName: 'read_file', toolCallId: 'c1', toolInput: { filePath: 'a.ts' }, ts: 3 },
    { role: 'tool' as const, content: '', toolName: 'read_file', toolCallId: 'c1', fullOutput: '文件内容', ts: 4 },
    { role: 'assistant' as const, content: '分析完成', ts: 5 },
    { role: 'system' as const, content: '📤 已提交', ts: 6 },
  ];
  const msgs = toNoteMessages(stream);
  ok(msgs.length === 4, `4 条 DisplayMessage（工具并入 agent 气泡，实际 ${msgs.length}）`);
  ok(msgs[0].role === 'user' && msgs[0].content === '任务：分析代码', 'user → user 气泡');
  ok(msgs[1].role === 'agent' && msgs[1].content === '开始分析', 'assistant → agent 气泡');
  ok(msgs[1].toolHistory?.length === 1, '工具调用并入 agent 气泡 toolHistory');
  ok(msgs[1].toolHistory?.[0]?.toolName === 'read_file', 'toolHistory 含工具名');
  ok(msgs[1].toolHistory?.[0]?.fullOutput === '文件内容', '工具结果回填到最后一个未完成调用');
  ok(msgs[2].role === 'agent' && msgs[2].content === '分析完成', '第二轮 assistant 独立气泡');
  ok(msgs[3].role === 'system' && msgs[3].content === '📤 已提交', 'system → system 气泡');
}

console.log('2) toNoteMessages 纯工具回合（无 assistant 文本）');
{
  const stream = [
    { role: 'user' as const, content: '任务', ts: 1 },
    { role: 'tool' as const, content: '', toolName: 'search_content', toolCallId: 'c2', toolInput: { content: 'x' }, ts: 2 },
    { role: 'tool' as const, content: '', toolName: 'search_content', toolCallId: 'c2', fullOutput: '命中', ts: 3 },
  ];
  const msgs = toNoteMessages(stream);
  ok(msgs.length === 2, `2 条 DisplayMessage（实际 ${msgs.length}）`);
  ok(msgs[1].role === 'agent' && msgs[1].toolHistory?.length === 1, '无文本时新建 agent 气泡承载工具历史');
  ok(msgs[1].toolHistory?.[0]?.fullOutput === '命中', '结果回填成功');
}

console.log('3) buildSessionFile 完整回合（含 tool-call + tool-result 配对）');
{
  const stream = [
    { role: 'user' as const, content: '任务', ts: 1 },
    { role: 'assistant' as const, content: '看下文件', ts: 2 },
    { role: 'tool' as const, content: '', toolName: 'read_file', toolCallId: 'c1', toolInput: { filePath: 'a.ts' }, ts: 3 },
    { role: 'tool' as const, content: '', toolName: 'read_file', toolCallId: 'c1', fullOutput: '内容X', ts: 4 },
  ];
  const file = buildSessionFile('sub1', stream);
  ok(file.version === 1 && file.kind === 'subagent-session', '文件含 version/kind 字段');
  ok(Array.isArray(file.agentMessages), 'agentMessages 为数组');
  const ams = file.agentMessages as any[];
  ok(ams.length === 3, `3 条消息（user/assistant+tools/tool-result，实际 ${ams.length}）`);
  ok(ams[0].role === 'user' && ams[0].content === '任务', '首条 user');
  ok(ams[1].role === 'assistant' && Array.isArray(ams[1].content), 'assistant 为 parts 数组');
  const parts = ams[1].content as any[];
  ok(parts.some(p => p.type === 'text' && p.text === '看下文件'), 'parts 含文本');
  ok(parts.some(p => p.type === 'tool-call' && p.toolCallId === 'c1'), 'parts 含 tool-call');
  ok(ams[2].role === 'tool' && (ams[2].content as any[])[0].output.value === '内容X', 'tool-result 正确配对');
}

console.log('4) buildSessionFile 未完成的工具调用 → 补充 toolResult');
{
  const stream = [
    { role: 'user' as const, content: '任务', ts: 1 },
    { role: 'assistant' as const, content: '执行中', ts: 2 },
    { role: 'tool' as const, content: '', toolName: 'add_patch', toolCallId: 'c9', toolInput: { filePath: 'b.ts' }, ts: 3 },
    // 无 c9 的 tool-result（模拟被中断）
  ];
  const file = buildSessionFile('sub2', stream);
  const ams = file.agentMessages as any[];
  ok(ams.length === 3, `3 条消息（user/assistant/补充tool-result，实际 ${ams.length}）`);
  const toolMsg = ams[ams.length - 1];
  ok(toolMsg.role === 'tool', '最后一条是 tool 消息（补充的 toolResult）');
  const out = (toolMsg.content as any[])[0];
  ok(out.type === 'tool-result' && out.toolCallId === 'c9', 'toolResult 的 toolCallId 正确');
  ok(String(out.output.value).includes('未完成'), 'toolResult 标记未完成');
}

console.log('5) buildSessionFile 收尾时未完成调用也补充');
{
  const stream = [
    { role: 'user' as const, content: '任务', ts: 1 },
    { role: 'assistant' as const, content: '第一轮', ts: 2 },
    { role: 'tool' as const, content: '', toolName: 'read_file', toolCallId: 'a1', toolInput: {}, ts: 3 },
    { role: 'tool' as const, content: '', toolName: 'read_file', toolCallId: 'a1', fullOutput: '有结果', ts: 4 },
    { role: 'assistant' as const, content: '第二轮', ts: 5 },
    { role: 'tool' as const, content: '', toolName: 'execute_command', toolCallId: 'a2', toolInput: { command: 'x' }, ts: 6 },
  ];
  const file = buildSessionFile('sub3', stream);
  const ams = file.agentMessages as any[];
  const last = ams[ams.length - 1];
  ok(last.role === 'tool' && (last.content as any[])[0].toolCallId === 'a2', '收尾为未完成调用补充 toolResult');
  const out = (last.content as any[])[0].output.value as string;
  ok(out.includes('未完成'), '补充的 toolResult 标记中断');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);


