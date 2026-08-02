/**
 * 验证 reconstructUIMessages 会过滤系统注入的 [工作记忆] / [知识库检索] / 【子模型提交】，
 * 同时保留真实用户消息与 assistant 回复。
 */
import { reconstructUIMessages } from '../src/command/commands/loadsession.command';

const agentMessages: any[] = [
  { role: 'user', content: '[工作记忆] 当前对话焦点与任务状态（系统注入）' },
  { role: 'user', content: '[知识库检索] 基于用户最新问题的检索结果（系统注入）' },
  { role: 'user', content: '【小码 提交工作结果】分析完成（子模型提交）' },
  { role: 'user', content: '帮我看看这个 bug' },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '思考中…' },
      { type: 'text', text: '好的，我来排查。' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { filePath: 'a.ts' } },
    ],
  },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', output: { value: '文件内容' } }] },
];

const ui = reconstructUIMessages({ agentMessages });
const userTexts = ui.filter((m) => m.role === 'user').map((m) => m.content);

const asserts: { name: string; ok: boolean }[] = [
  { name: '过滤 [工作记忆] 注入', ok: !userTexts.some((t) => t.startsWith('[工作记忆]')) },
  { name: '过滤 [知识库检索] 注入', ok: !userTexts.some((t) => t.startsWith('[知识库检索]')) },
  { name: '过滤 【子模型提交】', ok: !userTexts.some((t) => t.startsWith('【')) },
  { name: '保留真实用户消息', ok: userTexts.includes('帮我看看这个 bug') },
  { name: '保留 assistant 文本', ok: ui.some((m) => m.role === 'agent' && m.content.includes('好的，我来排查。')) },
  { name: '保留 reasoning 气泡', ok: ui.some((m) => m.role === 'thinking' && m.content === '思考中…') },
  { name: '保留 tool-call / tool-result', ok: ui.filter((m) => m.role === 'tool').length === 2 },
];

let failed = 0;
for (const a of asserts) {
  console.log(`${a.ok ? '✅' : '❌'} ${a.name}`);
  if (!a.ok) failed++;
}
console.log(failed === 0 ? '\n全部通过（' + asserts.length + ' 项）' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
