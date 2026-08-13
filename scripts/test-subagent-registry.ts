/**
 * test-subagent-registry.ts — 活跃子 Agent 注册状态持久化 + loadsession 恢复验证
 *
 * 1. subagentRegistryStore round-trip（按 sessionId 落盘 subagent-registry.json）
 * 2. manager.restore（恢复注册不删上下文 / status idle / createdAt 保留）
 * 3. manager.clearForLoad（清内存保留文件，切回可恢复）
 * 4. 完整链路：会话 A spawn → 保存 → 切 B 清空 → 切回 A 恢复
 *
 * 运行：npx tsx scripts/test-subagent-registry.ts
 */
import { subagentRegistryStore, type SubagentRegistryEntry } from '../src/tools/subagent-registry-store';
import { subAgentManager } from '../src/tools/inner_skills/sub-agent/manager';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-registry-'));
setWorkspaceRoot(tmp);

try {
  // ── 1. registry round-trip ──
  console.log('\n[1] subagentRegistryStore');
  subagentRegistryStore.setSessionId('test-sid');
  const entries: SubagentRegistryEntry[] = [
    {
      name: '渲染修复员',
      mode: 'mission',
      tools: ['read_file', 'add_patch'],
      systemPrompt: '你是渲染修复员',
      context: '渲染项目背景',
      createdAt: 1000,
    },
    {
      name: '开发引导员',
      mode: 'instructor',
      tools: [],
      requirement: '监督打工人',
      maxRounds: 5,
      createdAt: 2000,
      instructorRoundCount: 3,
      instructorMessages: [
        { role: 'user', content: '主模型输出' },
        { role: 'assistant', content: [{ type: 'text', text: '建议' }] },
      ],
    },
  ];
  subagentRegistryStore.save(entries);
  const fp = path.join(tmp, 'sessions', 'test-sid', 'subagent-registry.json');
  assert(fs.existsSync(fp), 'registry 落盘 sessions/{sid}/subagent-registry.json');
  const loaded = subagentRegistryStore.load();
  assert(loaded.length === 2, 'load 返回 2 条');
  assert(loaded[0].name === '渲染修复员' && loaded[0].mode === 'mission' && loaded[0].tools.length === 2, 'mission 字段完整');
  assert(loaded[1].mode === 'instructor' && loaded[1].instructorRoundCount === 3, 'instructor 状态完整');
  assert(loaded[1].instructorMessages?.length === 2, 'instructorMessages 完整');
  // 无文件时返回 []
  subagentRegistryStore.setSessionId('empty-sid');
  assert(subagentRegistryStore.load().length === 0, '无 registry 文件返回 []');
  subagentRegistryStore.setSessionId('test-sid');

  // ── 2. restore ──
  console.log('\n[2] manager.restore');
  subagentContextStore.setSessionId('test-sid');
  // 预置上下文（模拟该子 Agent 已有工作历史）
  subagentContextStore.save('渲染修复员', {
    name: '渲染修复员',
    mode: 'mission',
    tools: ['read_file'],
    context: '背景',
    messages: [{ role: 'user', content: '上次任务' }],
  });
  const ctxPath = path.join(tmp, 'sessions', 'test-sid', 'subagent', '渲染修复员.json');
  assert(fs.existsSync(ctxPath), '预置上下文文件存在');
  const restored = subAgentManager.restore(entries[0]);
  assert(!!subAgentManager.get('渲染修复员'), 'restore 后 get 命中');
  assert(restored.status === 'idle', 'status 复位为 idle');
  assert(restored.createdAt === 1000, 'createdAt 保留（排序稳定）');
  assert(fs.existsSync(ctxPath), 'restore 不清理持久化上下文');
  subAgentManager.restore(entries[1]);
  assert(subAgentManager.getAll().length === 2, 'getAll 含 2 个恢复的子 Agent');

  // ── 3. clearForLoad ──
  console.log('\n[3] manager.clearForLoad');
  subAgentManager.clearForLoad();
  assert(subAgentManager.getAll().length === 0, 'clearForLoad 清空内存注册');
  assert(fs.existsSync(ctxPath), 'clearForLoad 不删持久化上下文（切回可恢复）');
  const regPath = path.join(tmp, 'sessions', 'test-sid', 'subagent-registry.json');
  assert(fs.existsSync(regPath), 'registry 文件保留');

  // ── 4. 完整链路：会话 A spawn → 保存 → 切 B 清空 → 切回 A 恢复 ──
  console.log('\n[4] 会话切换完整链路');
  subagentRegistryStore.setSessionId('session-A');
  subagentContextStore.setSessionId('session-A');
  subAgentManager.spawn({ mode: 'mission', name: '小码', tools: ['read_file'], context: 'A 会话背景' });
  subAgentManager.spawn({ mode: 'instructor', name: '引导员', tools: [], requirement: '监工', maxRounds: 3 });
  subagentContextStore.save('小码', {
    name: '小码',
    mode: 'mission',
    tools: ['read_file'],
    context: 'A 会话背景',
    messages: [{ role: 'user', content: 'A 会话任务历史' }],
  });
  // 模拟 saveSessionToDisk 的 registry 写入（从 getAll 构造）
  subagentRegistryStore.save(subAgentManager.getAll().map((a) => ({
    name: a.name,
    mode: a.mode,
    tools: a.tools ?? [],
    systemPrompt: a.systemPrompt,
    context: a.context,
    requirement: a.requirement,
    maxRounds: a.maxRounds,
    createdAt: a.createdAt,
    instructorRoundCount: a.instructorRoundCount,
    instructorMessages: a.instructorMessages,
  })));
  assert(subAgentManager.getAll().length === 2, '会话 A：2 个子 Agent 活跃');

  // 切换到会话 B（loadsession 序列：clearForLoad → setSessionId(B)）
  subAgentManager.clearForLoad();
  subagentRegistryStore.setSessionId('session-B');
  subagentContextStore.setSessionId('session-B');
  assert(subAgentManager.getAll().length === 0, '会话 B：内存无子 Agent');

  // 切回会话 A（loadsession 序列：setSessionId(A) → registry.load → restore）
  subagentRegistryStore.setSessionId('session-A');
  subagentContextStore.setSessionId('session-A');
  const aEntries = subagentRegistryStore.load();
  for (const e of aEntries) subAgentManager.restore(e);
  assert(subAgentManager.getAll().length === 2, '切回 A：2 个子 Agent 恢复');
  const xiaoma = subAgentManager.get('小码');
  assert(!!xiaoma && xiaoma.mode === 'mission' && xiaoma.tools.includes('read_file'), '小码恢复（模式/工具完整）');
  const guide = subAgentManager.get('引导员');
  assert(!!guide && guide.mode === 'instructor' && guide.requirement === '监工', '引导员恢复（instructor 字段完整）');
  // 恢复后派活应能加载上下文（subagentContextStore 已切回 A）
  assert(subagentContextStore.getSessionId() === 'session-A', 'subagentContextStore 跟随切回 A');
  assert(subagentContextStore.load('小码')?.messages?.length === 1, '小码上下文可加载（派活延续）');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
} finally {
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
}
