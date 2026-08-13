/**
 * test-subagent-owner.ts — 子 Agent 按 sessionId 绑定验证
 *
 * 1. spawn/restore 记录 ownerSessionId
 * 2. queueSubmissionInjection 按 owner 会话分区（跨会话不触发排空）
 * 3. clearForLoad 保留 running mission、中断/清理其余
 * 4. spawn 同名 running 拒绝重建
 * 5. 上下文存储显式 sid（owner 分区写）
 *
 * 运行：npx tsx scripts/test-subagent-owner.ts
 */
import { subAgentManager, queueSubmissionInjection, drainPendingInjections, hasPendingInjections } from '../src/tools/inner_skills/sub-agent/manager';
import { subagentContextStore } from '../src/tools/subagent-context-store';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-owner-'));
setWorkspaceRoot(tmp);

// 监听器计数：跨会话提交不应触发
let listenerCalls = 0;

try {
  // ── 1. spawn / restore 的 ownerSessionId ──
  console.log('\n[1] ownerSessionId');
  subagentContextStore.setSessionId('session-A');
  subAgentManager.spawn({ mode: 'mission', name: '小码', tools: ['read_file'] });
  const xiaoma = subAgentManager.get('小码');
  assert(xiaoma?.ownerSessionId === 'session-A', 'spawn 记录当前会话为 owner');
  subagentContextStore.setSessionId('session-B');
  subAgentManager.restore({ mode: 'mission', name: '小码', tools: ['read_file'], createdAt: 1000 });
  const restored = subAgentManager.get('小码');
  assert(restored?.ownerSessionId === 'session-B', 'restore 记录当前会话为 owner');

  // ── 2. 提交按 owner 会话分区 ──
  console.log('\n[2] 提交路由按 owner');
  subagentContextStore.setSessionId('session-B');
  // 注册 listener：当前会话（B）的提交应触发
  subAgentManager.clearForLoad();
  // 用 setSubmissionListener 手动挂（测试直接验证函数逻辑）
  const { setSubmissionListener } = await import('../src/tools/inner_skills/sub-agent/manager');
  setSubmissionListener(() => { listenerCalls++; });

  // 跨会话提交（owner = A，当前 = B）：入队但不触发 listener
  subagentContextStore.setSessionId('session-B');
  queueSubmissionInjection('后台任务', { summary: 'A 的任务完成', details: 'd' }, 'session-A');
  assert(hasPendingInjections('session-A'), 'A 会话有待注入提交');
  assert(!hasPendingInjections('session-B'), 'B 会话无待注入提交');
  assert(listenerCalls === 0, '跨会话提交不触发当前排空', `触发 ${listenerCalls} 次`);
  // 当前会话提交：触发 listener
  queueSubmissionInjection('本地任务', { summary: 'B 的任务', details: 'd' }, 'session-B');
  assert(listenerCalls === 1, '当前会话提交触发排空');
  // drain 只取指定会话
  const bPending = drainPendingInjections('session-B');
  assert(bPending.length === 1 && bPending[0].name === '本地任务', 'drain(B) 只取 B 的提交');
  assert(hasPendingInjections('session-A'), 'A 的提交仍在队列（切回 A 时注入）');
  const aPending = drainPendingInjections('session-A');
  assert(aPending.length === 1 && aPending[0].payload.summary === 'A 的任务完成', 'drain(A) 取到跨会话后台任务提交');
  setSubmissionListener(null);

  // ── 3. clearForLoad 保留 running mission ──
  console.log('\n[3] clearForLoad 不中断后台任务');
  subagentContextStore.setSessionId('session-A');
  subAgentManager.clearForLoad();
  subAgentManager.spawn({ mode: 'mission', name: '后台工', tools: [] });
  subAgentManager.updateStatus('后台工', 'running');
  subAgentManager.spawn({ mode: 'instructor', name: '引导', tools: [] });
  subAgentManager.updateStatus('引导', 'running');
  // 切换会话（loadsession B 场景）
  subagentContextStore.setSessionId('session-B');
  subAgentManager.clearForLoad();
  const after = subAgentManager.getAll().map(a => a.name);
  assert(after.includes('后台工'), 'running mission 保留（后台继续）');
  assert(!after.includes('引导'), 'running instructor 被清理（跨会话无意义）');
  // 保留的 running mission 仍可按 owner 找到
  const bg = subAgentManager.get('后台工');
  assert(bg?.ownerSessionId === 'session-A', '保留的后台任务 owner 仍是 A');

  // ── 4. spawn 同名 running 拒绝 ──
  console.log('\n[4] spawn 同名 running 保护');
  let threw = false;
  try {
    subAgentManager.spawn({ mode: 'mission', name: '后台工', tools: [] });
  } catch (e: any) {
    threw = true;
    assert(String(e.message).includes('正在运行中'), '抛错提示运行中');
  }
  assert(threw, '同名 running 时 spawn 抛错（防跨会话覆盖）');
  // 完成后可重建
  subAgentManager.setSubmission('后台工', JSON.stringify({ summary: '完成', details: 'd' }));
  subAgentManager.spawn({ mode: 'mission', name: '后台工', tools: [] });
  assert(subAgentManager.get('后台工')?.status === 'idle', '完成后同名重建成功');

  // ── 5. 上下文存储显式 sid（owner 分区） ──
  console.log('\n[5] 上下文按 owner 分区');
  subagentContextStore.setSessionId('session-A');
  subagentContextStore.save('分区工', {
    name: '分区工', mode: 'mission', tools: [],
    messages: [{ role: 'user', content: 'A 的历史' }],
  });
  // 切到 B 后用显式 sid=A 读取（模拟后台任务在 A 分区落盘）
  subagentContextStore.setSessionId('session-B');
  const fromA = subagentContextStore.load('分区工', 'session-A');
  assert(fromA?.messages?.length === 1, '显式 sid 读 A 分区');
  assert(subagentContextStore.load('分区工') === undefined, '当前 B 分区无该上下文（不串）');
  const aFile = path.join(tmp, 'sessions', 'session-A', 'subagent', '分区工.json');
  assert(fs.existsSync(aFile), '上下文落在 A 会话文件夹');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
} finally {
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
