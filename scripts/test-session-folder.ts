/**
 * 验证 session 文件夹化保存/加载与迁移：
 * 1. saveSessionToDisk → sessions/{sessionId}/session.json（不含 payloads）+ payload.json（payloads 独立拆分）
 * 2. listSessionFiles 扫描文件夹结构（兼容旧单文件）
 * 3. worklog-store 落盘 sessions/{sessionId}/worklog/entries.json；旧路径 sessions/worklogs/{sid}.json 自动迁移
 * 4. subagent-context-store 按 sessions/{sessionId}/subagent/{name}.json 存取
 * 5. slimMessages 截断超大工具结果 / cleanPersistedMessages 过滤未闭环 tool-call
 */
import { CLIAAgent } from '../src/agent';
import { worklogStore } from '../src/tools/worklog-store';
import {
  subagentContextStore,
  slimMessages,
  cleanPersistedMessages,
} from '../src/tools/subagent-context-store';
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

// ── 隔离：临时工作区（测试产物不污染真实 sessions/） ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-session-test-'));
setWorkspaceRoot(tmp);
const sessionsDir = path.join(tmp, 'sessions');

try {
  // ── 1. saveSessionToDisk 文件夹化 ──
  console.log('\n[1] saveSessionToDisk → session.json + payload.json 拆分');
  const agent = new CLIAAgent({} as any, 'test-system-prompt');
  agent.setSessionId('test-fixed-id');
  agent.setMessages([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！有什么可以帮你？' },
  ]);
  (agent as any).recordPayload({
    system: 'sys',
    messages: [{ role: 'user', content: '你好' }],
    tools: { read_file: { description: 'read' } },
    thinking: false,
  });
  const dir = agent.saveSessionToDisk();
  assert(dir === path.join(sessionsDir, 'test-fixed-id'), '返回 sessions/{sessionId} 文件夹路径', dir ?? 'null');
  const sessionJson = path.join(sessionsDir, 'test-fixed-id', 'session.json');
  const payloadJson = path.join(sessionsDir, 'test-fixed-id', 'payload.json');
  assert(fs.existsSync(sessionJson), 'session.json 存在');
  assert(fs.existsSync(payloadJson), 'payload.json 存在');
  const sessionData = JSON.parse(fs.readFileSync(sessionJson, 'utf-8'));
  assert(sessionData.version === 2, 'session.json 版本号 2');
  assert(Array.isArray(sessionData.agentMessages) && sessionData.agentMessages.length === 2, '主会话含 agentMessages');
  assert(sessionData.sessionId === 'test-fixed-id', 'session.json 记录 sessionId');
  assert(sessionData.payloads === undefined, 'session.json 不含 payloads（已拆分）');
  const payloadData = JSON.parse(fs.readFileSync(payloadJson, 'utf-8'));
  assert(Array.isArray(payloadData.payloads) && payloadData.payloads.length === 1, 'payload.json 含 payloads');
  assert(payloadData.payloads[0].system === 'sys', 'payload 内容完整');
  // 无消息时不创建
  const agent2 = new CLIAAgent({} as any, 'test-system-prompt');
  agent2.setSessionId('test-empty');
  assert(agent2.saveSessionToDisk() === null, '无消息时返回 null 不创建文件夹');

  // ── 2. listSessionFiles 文件夹扫描 + 旧单文件兼容 ──
  console.log('\n[2] listSessionFiles');
  const { listSessionFiles } = await import('../src/command/commands/loadsession.command');
  let files = listSessionFiles();
  assert(files.some((f) => f.name === 'test-fixed-id' && f.filePath.endsWith('session.json')), '扫到文件夹会话 test-fixed-id');
  // 旧单文件兼容
  fs.writeFileSync(path.join(sessionsDir, 'legacy.json'), JSON.stringify({ version: 1, agentMessages: [{ role: 'user', content: '旧' }] }, null, 2));
  files = listSessionFiles();
  assert(files.some((f) => f.name === 'legacy' && f.filePath.endsWith('legacy.json')), '兼容旧单文件 legacy.json');
  assert(files.some((f) => f.name === 'test-fixed-id'), '文件夹与旧文件同时列出');

  // ── 3. worklog-store 新路径 + 旧路径迁移 ──
  console.log('\n[3] worklog-store 文件夹化 + 旧路径迁移');
  worklogStore.setSessionId('test-wl');
  worklogStore.add({ id: 'W1', title: '测试归档', summary: 's', archivedMessages: [], createdAt: new Date().toISOString() });
  assert(fs.existsSync(path.join(sessionsDir, 'test-wl', 'worklog', 'entries.json')), '新路径落盘 worklog/entries.json');
  assert(!fs.existsSync(path.join(sessionsDir, 'worklogs')), '不创建旧 worklogs 目录');
  assert(worklogStore.list().length === 1 && worklogStore.list()[0].id === 'W1', '内存态读取一致');
  // 旧路径迁移：构造旧文件 → 切换会话加载 → 自动迁移
  fs.mkdirSync(path.join(sessionsDir, 'worklogs'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'worklogs', 'legacy-wl.json'),
    JSON.stringify({ sessionId: 'legacy-wl', entries: [{ id: 'W1', title: '旧归档', summary: '旧', archivedMessages: [], createdAt: 'x' }] }, null, 2),
  );
  worklogStore.setSessionId('legacy-wl');
  const migrated = worklogStore.get('W1');
  assert(migrated?.title === '旧归档', '旧路径归档可读');
  assert(fs.existsSync(path.join(sessionsDir, 'legacy-wl', 'worklog', 'entries.json')), '旧数据已迁移到新路径');
  assert(!fs.existsSync(path.join(sessionsDir, 'worklogs', 'legacy-wl.json')), '旧文件已删除');

  // ── 4. subagent-context-store ──
  console.log('\n[4] subagent-context-store');
  subagentContextStore.setSessionId('test-sa');
  subagentContextStore.save('worker1', {
    name: 'worker1',
    mode: 'mission',
    tools: ['read_file'],
    messages: [{ role: 'user', content: 'hi' }],
  });
  const loaded = subagentContextStore.load('worker1');
  assert(loaded !== undefined && loaded.messages.length === 1, 'save/load round-trip');
  assert(loaded!.mode === 'mission' && loaded!.tools[0] === 'read_file', '身份信息完整');
  assert(fs.existsSync(path.join(sessionsDir, 'test-sa', 'subagent', 'worker1.json')), '落盘 sessions/{sid}/subagent/{name}.json');
  assert(subagentContextStore.list().includes('worker1'), 'list 返回持久化子 Agent 名');
  subagentContextStore.remove('worker1');
  assert(subagentContextStore.load('worker1') === undefined, 'remove 后不可加载');
  assert(!subagentContextStore.list().includes('worker1'), 'remove 后 list 不含');
  // 会话分区隔离
  subagentContextStore.setSessionId('other-session');
  assert(subagentContextStore.load('worker1') === undefined, '不同 session 分区互不可见');

  // ── 5. slimMessages / cleanPersistedMessages ──
  console.log('\n[5] 消息瘦身与未闭环清理');
  const big = 'x'.repeat(5000);
  const bigMsgs: any[] = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: big } }] }];
  const slim = slimMessages(bigMsgs);
  const slimVal = slim[0].content[0].output.value;
  assert(typeof slimVal === 'string' && slimVal.length <= 2100, `超大工具结果截断（${slimVal.length} 字符）`);
  assert(slimVal.includes('截断'), '含截断标记');
  const many = Array.from({ length: 150 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
  const slimMany = slimMessages(many);
  assert(slimMany.length === 120, `消息条数上限 120（实际 ${slimMany.length}）`);
  assert(slimMany[0].content === 'm30', '截断最早消息');
  // 未闭环 tool-call：保留 + 构造 ToolResult 占位（配对完整，不丢上下文）
  const broken: any[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: {} }, { type: 'text', text: '继续' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: 'ok' } }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'read_file', input: {} }] },
  ];
  const cleaned = cleanPersistedMessages(broken);
  assert(cleaned.length === 4, `未闭环 tool-call 保留 + 补 ToolResult（共 ${cleaned.length} 条）`);
  assert(JSON.stringify(cleaned).includes('c2'), '未闭环调用保留（不截断）');
  assert(JSON.stringify(cleaned).includes('[未完成] 工具调用被中断'), '为未闭环调用构造 ToolResult 占位');
  assert(JSON.stringify(cleaned).includes('继续'), '同一条消息中的文本部分保留');
} finally {
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);

