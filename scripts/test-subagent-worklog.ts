/**
 * 验证子 Agent 上下文压缩（Worklog 落盘 subagent-worklog 文件夹）：
 * 1. SubagentWorklogStore round-trip（按 会话+子Agent 分区，落盘路径）
 * 2. compactMessages 注入 subagentWorklogStore（mock summarize 快速压缩）
 *    - 压缩计划生成 + 应用到消息列表（[Worklog] 插入头部）
 *    - store 落盘记录
 * 3. agent_worklog 工具 execute（无参列人 / 带 name 列表 / 带 id 梗概）
 */
import { compactMessages, maxContextTokens } from '../src/context-compactor';
import { SubagentWorklogStore } from '../src/tools/subagent-worklog-store';
import { setWorkspaceRoot, resetWorkspaceRoot } from '../src/workdir';
import type { WorklogEntry } from '../src/tools/worklog-store';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-sub-wl-'));
setWorkspaceRoot(tmp);

try {
  // ── 1. SubagentWorklogStore round-trip ──
  console.log('\n[1] SubagentWorklogStore');
  const store = new SubagentWorklogStore();
  store.setSessionId('test-sid');
  store.setActiveAgent('渲染修复员');
  const e1: WorklogEntry = {
    id: 'W1',
    title: '修复按钮样式',
    summary: '【标题】修复按钮样式\n【关键决策】用 flex 布局',
    archivedMessages: [{ role: 'user', content: '改样式' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  store.add(e1);
  const fp = path.join(tmp, 'sessions', 'test-sid', 'subagent-worklog', '渲染修复员.json');
  assert(fs.existsSync(fp), '工作记录落盘 sessions/{sid}/subagent-worklog/{agentName}.json');
  const disk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  assert(disk.agentName === '渲染修复员' && disk.entries.length === 1, '磁盘文件含 agentName 与记录');
  assert(store.get('W1')?.title === '修复按钮样式', 'get 命中');
  assert(store.nextId() === 'W2', 'id 自增');

  // 第二个子 Agent 独立分区
  store.setActiveAgent('后端开发');
  store.add({ id: 'W1', title: '重构 API', summary: '摘要', archivedMessages: [], createdAt: '2026-01-02T00:00:00.000Z' });
  const fp2 = path.join(tmp, 'sessions', 'test-sid', 'subagent-worklog', '后端开发.json');
  assert(fs.existsSync(fp2), '不同子 Agent 各自落盘');
  store.setActiveAgent('渲染修复员');
  assert(store.list().length === 1, '子 Agent 分区互不可见（渲染修复员仅 1 条）');

  // listAgents（模拟重启：新实例扫磁盘）
  const fresh = new SubagentWorklogStore();
  fresh.setSessionId('test-sid');
  const agents = fresh.listAgents();
  assert(agents.length === 2, `listAgents 扫到 2 个有记录的子 Agent（实际 ${agents.length}）`);
  assert(agents.some((a) => a.agentName === '渲染修复员' && a.count === 1), 'listAgents 含渲染修复员（1 条）');
  assert(agents.some((a) => a.agentName === '后端开发' && a.lastTitle === '重构 API'), 'listAgents 含最近标题');

  // ── 2. compactMessages 注入 store（mock summarize） ──
  console.log('\n[2] compactMessages 注入 subagentWorklogStore');
  const s2 = new SubagentWorklogStore();
  s2.setSessionId('test-sid');
  s2.setActiveAgent('测测');
  const snapshot = [
    { role: 'user', content: '任务：测试登录页' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a1', toolName: 'read_file', input: { filePath: 'login.ts' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a1', toolName: 'read_file', output: { type: 'text', value: '内容' } }] },
    { role: 'user', content: '继续，测注册页' },
    { role: 'assistant', content: '注册页测完' },
  ];
  // 当前 input token 超阈值 → 触发压缩（mock summarize 返回固定梗概）
  const trigger = maxContextTokens() + 10000;
  const plan = await compactMessages(
    snapshot as any,
    'test-sid',
    trigger,
    async (roundMessages) => {
      const inputs = roundMessages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
      return { title: '测试页面', summary: `【标题】测试页面\n【用户意图】${inputs.join(' / ')}` };
    },
    s2,
  );
  assert(plan !== null, '超预算时生成压缩计划');
  assert(plan!.roundsRemoved === 1, `移除 1 轮（实际 ${plan!.roundsRemoved}）`);
  assert(plan!.insertMessages.some((m) => typeof m.content === 'string' && m.content.startsWith('[Worklog#W1]')), '插入 [Worklog#W1] 消息');
  assert(s2.get('W1')?.title === '测试页面', 'store 已归档 W1');

  // 应用计划到消息列表（模拟 runner 的 splice）
  const applied = [...(snapshot as any)];
  applied.splice(0, plan!.removeCount, ...plan!.insertMessages);
  assert(applied[0].content.startsWith('[Worklog#W1]'), '应用后头部为 Worklog 消息');
  assert(applied.length < snapshot.length, '应用后消息数减少');

  // 落盘验证
  const fp3 = path.join(tmp, 'sessions', 'test-sid', 'subagent-worklog', '测测.json');
  assert(fs.existsSync(fp3), '压缩产物落盘（测测.json）');
  const disk3 = JSON.parse(fs.readFileSync(fp3, 'utf-8'));
  assert(disk3.entries.length === 1 && disk3.entries[0].archivedMessages.length > 0, '落盘含完整归档消息');

  // 再次压缩：二级消退（头部已有 [Worklog]，最旧 Worklog 降级为归档行）
  const snapshot2 = [
    ...plan!.insertMessages,
    { role: 'user', content: '新任务：性能测试' },
    { role: 'assistant', content: '完成性能测试' },
    { role: 'user', content: '新任务：回归测试' },
    { role: 'assistant', content: '完成回归测试' },
  ];
  const plan2 = await compactMessages(
    snapshot2 as any,
    'test-sid',
    trigger,
    async () => ({ title: '性能测试', summary: '【标题】性能测试' }),
    s2,
  );
  assert(plan2 !== null, '二次压缩生成计划');
  assert(plan2!.insertMessages.some((m) => typeof m.content === 'string' && m.content.includes('已归档')), '最旧 Worklog 二级消退为归档行');
  assert(s2.get('W2')?.title === '性能测试', 'store 归档 W2');
  assert(s2.list().length === 2, 'store 共 2 条记录');

  // ── 3. agent_worklog 工具 execute ──
  console.log('\n[3] agent_worklog 工具');
  const { default: subAgentTools } = await import('../src/tools/inner_skills/sub-agent/index');
  const agentWorklogTool = subAgentTools['agent_worklog'];
  // 工具内部用全局 subagentWorklogStore + subagentContextStore 的 sessionId 定位
  const { subagentContextStore } = await import('../src/tools/subagent-context-store');
  const { subagentWorklogStore } = await import('../src/tools/subagent-worklog-store');
  subagentContextStore.setSessionId('test-sid');
  subagentWorklogStore.setSessionId('test-sid');
  // 无参：列出所有有记录的 Agent（扫 test-sid 分区磁盘）
  const listAll = await agentWorklogTool.execute!({} as any, {} as any);
  assert(String(listAll).includes('渲染修复员') && String(listAll).includes('后端开发'), '无参列出有记录的子 Agent');
  assert(String(listAll).includes('优先'), '无参输出含复用提示');
  // 带 name：列出该 Agent 的记录列表
  const listOne = await agentWorklogTool.execute!({ name: '渲染修复员' } as any, {} as any);
  assert(String(listOne).includes('修复按钮样式'), '带 name 列出记录');
  // 带 name+id：完整梗概
  const detail = await agentWorklogTool.execute!({ name: '渲染修复员', id: 'W1' } as any, {} as any);
  assert(String(detail).includes('flex 布局'), '带 id 返回完整梗概');
  // 未知 Agent 友好提示
  const unknown = await agentWorklogTool.execute!({ name: '不存在的人' } as any, {} as any);
  assert(String(unknown).includes('暂无工作记录'), '未知 Agent 友好提示');
} finally {
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);



