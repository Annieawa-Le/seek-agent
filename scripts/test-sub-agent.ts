/**
 * test-sub-agent.ts — 子模型系统自测
 *
 * 重点验证 ESM 修复：runner.ts 的 getGlobalTools 从 require 改为动态 import，
 * 子模型必须能拿到全局工具注册表（此前 require 在 ESM 下抛错被吞，子模型拿不到工具）。
 *
 * 运行：npx tsx scripts/test-sub-agent.ts
 */
import { subAgentManager } from '../src/tools/inner_skills/sub-agent/manager';

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('1) 全局工具注册表（runner 动态 import 路径）');
// runner.ts 的路径：src/tools/inner_skills/sub-agent/runner.ts → '../../index' = src/tools/index
const mod = await import('../src/tools/index');
assert('src/tools/index 有 tools 导出', !!(mod as any).tools);
const tools = (mod as any).tools as Record<string, any>;
assert('tools 含核心工具 read_file', !!tools.read_file);
assert('tools 含 patch 工具 add_patch', !!tools.add_patch);
assert('tools 含子模型工具 spawn_agent', !!tools.spawn_agent);
assert('tools 含子模型工具 agent_task', !!tools.agent_task);
assert('tools 含子模型工具 agent_query', !!tools.agent_query);

console.log('2) SubAgentManager 生命周期');
const cfg = {
  mode: 'mission' as const,
  name: 'test-worker',
  tools: ['read_file', 'search_all_file'],
  systemPrompt: '你是测试子模型',
  context: '测试上下文',
};
subAgentManager.spawn(cfg);
assert('spawn 后存在', !!subAgentManager.get('test-worker'));
const agent = subAgentManager.get('test-worker')!;
assert('模式为 mission', agent.mode === 'mission');
assert('工具列表正确', agent.tools.join(',') === 'read_file,search_all_file');
assert('初始状态 idle', agent.status === 'idle');

subAgentManager.updateStatus('test-worker', 'running');
assert('状态更新为 running', subAgentManager.get('test-worker')!.status === 'running');

subAgentManager.setSubmission('test-worker', JSON.stringify({ summary: '完成', details: '细节' }));
assert('提交后状态 done', subAgentManager.get('test-worker')!.status === 'done');
assert('提交内容保存', (subAgentManager.get('test-worker')!.submission ?? '').includes('完成'));

subAgentManager.fire('test-worker');
assert('销毁后不存在', !subAgentManager.get('test-worker'));

console.log('3) 等待提交机制');
subAgentManager.spawn({ mode: 'mission', name: 'waiter', tools: [] });
const waitPromise = subAgentManager.waitForSubmission('waiter');
subAgentManager.setSubmission('waiter', JSON.stringify({ summary: 'ok', details: 'd' }));
const waited = await waitPromise;
assert('waitForSubmission 收到结果', waited.includes('ok'));
subAgentManager.fire('waiter');

console.log('4) a_submission 工具行为（安全兜底）');
const { tools: skillTools } = await import('../src/tools/index');
const submissionTool = skillTools['a_submission'];
assert('a_submission 已注册', !!submissionTool);
if (submissionTool?.execute) {
  const out = await submissionTool.execute({ summary: 's', details: 'd' });
  assert('a_submission 返回 JSON 兜底', typeof out === 'string' && out.includes('submission'));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
