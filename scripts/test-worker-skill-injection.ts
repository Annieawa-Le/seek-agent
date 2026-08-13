/**
 * test-worker-skill-injection.ts — 验证 spawn_worker skills 参数功能
 *
 * 验证（现在每位员工都有默认技能，spawn_worker 自动加载）：
 * 1. 默认技能自动注入
 * 2. 显式技能与默认技能合并去重
 * 3. 多技能时说明注入完整
 * 4. 无效技能名不阻塞
 */
import { subAgentManager } from '../src/tools/inner_skills/sub-agent/manager.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

async function main() {
  const tools = (await import('../src/tools/inner_skills/worker-library/index.ts')).default;
  const spawn = (args: any) => tools['spawn_worker'].execute(args);

  // tester 原始工具数
  const TESTER_TOOL_COUNT = 15;

  // ── 1. 默认技能自动注入（无显式 skills 参数） ──
  console.log('\n[1] 默认技能自动注入');
  const r1 = await spawn({ worker: 'tester', name: 'test-skill-default' });
  const a1 = subAgentManager.get('test-skill-default');
  assert(r1.includes('✅'), '创建成功');
  assert(r1.includes('默认技能(3)'), '返回信息含默认技能计数');
  assert(r1.includes('ts-debug, browser-control, code-graph'), '返回信息含默认技能名');
  assert(a1!.systemPrompt.includes('已解锁技能'), '提示词含技能段');
  assert(a1!.tools.length > TESTER_TOOL_COUNT, `工具数 > ${TESTER_TOOL_COUNT}: ${a1!.tools.length}`);
  assert(a1!.tools.some((t: string) => t.startsWith('browser_')), '含 browser_ 工具（来自默认技能）');
  assert(a1!.tools.some((t: string) => t === 'ts_typecheck' || t === 'ts_run_test'), '含 ts-debug 工具');
  assert(a1!.tools.some((t: string) => t === 'list_symbols' || t === 'read_symbol'), '含 code-graph 工具');
  subAgentManager.fire('test-skill-default');

  // ── 2. 显式技能 + 默认技能合并 ──
  console.log('\n[2] 默认技能 + 显式技能合并');
  const r2 = await spawn({ worker: 'tester', name: 'test-skill-merge', skills: ['html-toolkit'] });
  const a2 = subAgentManager.get('test-skill-merge');
  assert(r2.includes('✅'), '创建成功');
  assert(r2.includes('默认技能(3)'), '返回信息含默认技能计数');
  assert(r2.includes('额外技能(1)'), '返回信息含额外技能计数');
  assert(a2!.tools.length > a1!.tools.length, `合并后工具数多于纯默认: ${a2!.tools.length} > ${a1!.tools.length}`);
  assert(a2!.tools.some((t: string) => t === 'html_toolkit' || t === 'html-toolkit-prompt-get'), '含 html-toolkit 工具');
  assert(a2!.systemPrompt.includes('html-toolkit'), '提示词含合并技能名');
  assert(a2!.systemPrompt.includes('HTML 页面调试运行'), '提示词含 html-toolkit 描述');
  subAgentManager.fire('test-skill-merge');

  // ── 3. 多技能合并 ──
  console.log('\n[3] 多技能合并 [browser-control, code-graph]（部分已在默认中）');
  const r3 = await spawn({ worker: 'tester', name: 'test-skill-multi-merge', skills: ['browser-control', 'code-graph'] });
  const a3 = subAgentManager.get('test-skill-multi-merge');
  assert(r3.includes('✅'), '创建成功');
  assert(r3.includes('默认技能(3)'), '返回信息含默认技能计数');
  assert(r3.includes('额外技能(2)'), '返回信息含额外技能x2');
  // browser-control 和 code-graph 已在默认中，不重复加
  assert(a3!.tools.length === a1!.tools.length, '去重后工具数与纯默认一致');
  assert(a3!.systemPrompt.includes('browser-control'), '提示词含 browser-control');
  assert(a3!.systemPrompt.includes('code-graph'), '提示词含 code-graph');
  assert(a3!.systemPrompt.includes('优先使用 browser-control'), '提示词含 browser 的 SYSTEM_INJECTION');
  subAgentManager.fire('test-skill-multi-merge');

  // ── 4. 无效技能名 ──
  console.log('\n[4] 无效技能名（默认技能仍正常注入）');
  const r4 = await spawn({ worker: 'tester', name: 'test-skill-invalid', skills: ['non-existent-skill'] });
  const a4 = subAgentManager.get('test-skill-invalid');
  assert(r4.includes('✅'), '创建成功（不阻塞）');
  assert(a4!.systemPrompt.includes('未找到该技能'), '提示词含未找到提示');
  assert(a4!.systemPrompt.includes('已解锁技能'), '默认技能段仍在');
  assert(a4!.tools.length === a1!.tools.length, '工具数与纯默认一致（无效技能不增加工具）');
  subAgentManager.fire('test-skill-invalid');

  // ── 汇总 ──
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项:', failures.join(', '));
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e); process.exit(1); });