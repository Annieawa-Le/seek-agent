/**
 * /loadsession 端到端验证（WebUI 会话切换路径：session:switch → /loadsession {name}）
 * 1. 文件夹结构加载：sessions/{sessionId}/session.json + payload.json 合并恢复 payload 历史
 * 2. 会话 ID / 标题 / 消息恢复
 * 3. 旧单文件兼容加载（迁移前）
 */
import { CLIAAgent } from '../src/agent';
import { LoadSessionCommand } from '../src/command/commands/loadsession.command';
import { setWorkspaceRoot, resetWorkspaceRoot } from '../src/workdir';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-load-e2e-'));
setWorkspaceRoot(tmp);
const sessionsDir = path.join(tmp, 'sessions');

function makeUi() {
  const calls: any[] = [];
  const ui = {
    addUserMessage: (m: string) => calls.push({ type: 'user', content: m }),
    addAgentMessage: (m: string) => calls.push({ type: 'agent', content: m }),
    replaceMessages: (msgs: any[]) => calls.push({ type: 'replace', msgs }),
    clearMessages: () => {},
  };
  return { ui, calls };
}

try {
  // ── 准备：文件夹会话（含 payload.json） ──
  const agent = new CLIAAgent({} as any, 'test-system-prompt');
  agent.setSessionId('abcd-1234-wxyz');
  agent.setMessages([
    { role: 'user', content: '帮我看看代码' },
    { role: 'assistant', content: '好的，正在查看' },
  ]);
  agent.setSessionTitle('代码审查');
  (agent as any).recordPayload({
    system: 'sys',
    messages: [{ role: 'user', content: '帮我看看代码' }],
    tools: {},
    thinking: false,
  });
  const dir = agent.saveSessionToDisk();
  assert(dir !== null && fs.existsSync(path.join(dir!, 'payload.json')), '夹具：文件夹会话已保存（含 payload.json）');

  // ── 1. 文件夹结构加载 ──
  console.log('\n[1] /loadsession {sessionId}（文件夹结构）');
  const { ui, calls } = makeUi();
  const agent2 = new CLIAAgent(ui as any, 'test-system-prompt');
  LoadSessionCommand.execute('/loadsession abcd-1234-wxyz', { ui: ui as any, agent: agent2 } as any);
  assert(agent2.getMessages().length === 2, 'agentMessages 恢复（2 条）');
  assert(agent2.getMessages()[0].role === 'user' && agent2.getMessages()[1].role === 'assistant', '消息内容完整');
  const ph = agent2.getPayloadHistory();
  assert(Array.isArray(ph) && ph.length === 1, `payload 历史从 payload.json 合并恢复（${ph.length} 条）`);
  assert(ph[0]?.system === 'sys', 'payload 内容正确');
  assert(agent2.getSessionId() === 'abcd-1234-wxyz', 'sessionId 与文件内身份对齐');
  assert(agent2.getSessionTitle() === '代码审查', '标题恢复');
  assert(calls.some((c) => c.type === 'replace' && Array.isArray(c.msgs) && c.msgs.length >= 1), 'UI 消息整体替换（WebUI 重放）');
  assert(!calls.some((c) => c.type === 'agent' && typeof c.content === 'string' && c.content.startsWith('❌')), '无错误提示');

  // 保存后自动写回同一文件夹（落点稳定）
  agent2.setMessages([...agent2.getMessages(), { role: 'user', content: '继续' }]);
  const dir2 = agent2.saveSessionToDisk();
  assert(dir2 === dir, '再次保存仍写回同一文件夹（标题变化不漂移）');
  const sessionJson2 = JSON.parse(fs.readFileSync(path.join(dir2!, 'session.json'), 'utf-8'));
  assert(sessionJson2.agentMessages.length === 3, 'session.json 已更新');

  // ── 2. 旧单文件兼容加载 ──
  console.log('\n[2] /loadsession {legacy}（旧单文件兼容）');
  fs.writeFileSync(
    path.join(sessionsDir, 'legacy-title.json'),
    JSON.stringify({ version: 1, sessionId: 'legacy-fixed-id', title: '旧会话', agentMessages: [{ role: 'user', content: '旧消息' }] }, null, 2),
  );
  const { ui: ui3, calls: calls3 } = makeUi();
  const agent3 = new CLIAAgent(ui3 as any, 'test-system-prompt');
  LoadSessionCommand.execute('/loadsession legacy-title', { ui: ui3 as any, agent: agent3 } as any);
  assert(agent3.getMessages().length === 1 && agent3.getMessages()[0].content === '旧消息', '旧单文件加载成功');
  assert(agent3.getSessionId() === 'legacy-fixed-id', '旧文件 sessionId 对齐');
  assert(!calls3.some((c) => c.type === 'agent' && typeof c.content === 'string' && c.content.startsWith('❌')), '旧文件加载无错误');

  // ── 3. 模糊匹配（未精确命中时按名称包含） ──
  console.log('\n[3] 模糊匹配');
  const { ui: ui4 } = makeUi();
  const agent4 = new CLIAAgent(ui4 as any, 'test-system-prompt');
  LoadSessionCommand.execute('/loadsession legacy', { ui: ui4 as any, agent: agent4 } as any);
  assert(agent4.getMessages().length === 1, '模糊匹配加载旧会话');
  const { ui: ui5 } = makeUi();
  const agent5 = new CLIAAgent(ui5 as any, 'test-system-prompt');
  LoadSessionCommand.execute('/loadsession 不存在会话', { ui: ui5 as any, agent: agent5 } as any);
  assert(agent5.getMessages().length === 0, '未命中时不恢复消息');
} finally {
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);








