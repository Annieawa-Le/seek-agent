/**
 * test-finish-to-step.ts — finish_to_step 工具验证
 * 覆盖：跳到第 N 步（1..N 完成）、全部完成、越界报错、不存在 todo、重复调用提示。
 */
import assert from 'node:assert';
import { createTodo, finishToStep } from '../src/tools/todo';
import { setTodos } from '../src/tools/todo-state';

async function main() {
  let pass = 0;
  const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

  // 清空状态，创建 4 步 todo
  setTodos([]);
  await createTodo.execute({ name: 'demo', steps: ['a', 'b', 'c', 'd'] });

  console.log('── 跳到 Step 2（1..2 完成）──');
  const r1 = await finishToStep.execute({ name: 'demo', step: 2 });
  const txt1 = r1.toString();
  ok('返回消息含完成到 Step 2', txt1.includes('完成到 Step 2'));
  ok('消息含本次标记 2 步', txt1.includes('本次标记 2 步'));
  const bulk1 = (r1 as any).rawBulk;
  ok('bulk action 为 finish-to', bulk1.action === 'finish-to');
  ok('bulk doneCount 为 2', bulk1.doneCount === 2);
  const steps1 = bulk1.steps;
  ok('Step1 完成', steps1[0].completed === true);
  ok('Step2 完成', steps1[1].completed === true);
  ok('Step3 未完成', steps1[2].completed === false);
  ok('Step4 未完成', steps1[3].completed === false);

  console.log('── 再跳到 Step 4（全部完成，仅标记 2 步）──');
  const r2 = await finishToStep.execute({ name: 'demo', step: 4 });
  ok('消息含本次标记 2 步', r2.toString().includes('本次标记 2 步'));
  const bulk2 = (r2 as any).rawBulk;
  ok('doneCount 为 4', bulk2.doneCount === 4);
  ok('Step3 完成', bulk2.steps[2].completed === true);
  ok('Step4 完成', bulk2.steps[3].completed === true);

  console.log('── 重复调用（已全完成）──');
  const r3 = await finishToStep.execute({ name: 'demo', step: 4 });
  ok('已全完成时提示本就如此', r3.toString().includes('本就如此'));

  console.log('── 错误路径 ──');
  const bad0 = await finishToStep.execute({ name: 'demo', step: 0 });
  ok('step 0 报序号无效', bad0.toString().includes('序号无效'));
  const bad5 = await finishToStep.execute({ name: 'demo', step: 5 });
  ok('step 5 越界报序号无效', bad5.toString().includes('序号无效'));
  const miss = await finishToStep.execute({ name: 'nope', step: 2 });
  ok('不存在的 todo 报错', miss.toString().includes('未找到'));

  console.log(`\n🎉 全部通过（${pass} 项断言）`);
}

main().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
