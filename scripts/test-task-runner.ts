/**
 * test-task-runner.ts — 后台任务工具实机验证
 * 覆盖：启动短任务→完成、长任务运行中→switch 查看→kill、
 *      task_list、同名拒绝、错误路径（不存在/已结束）。
 */
import assert from 'node:assert';
import { taskRunner, taskExecuteTool, taskSwitchTool, taskListTool, taskKillTool } from '../src/tools/task-runner';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  let pass = 0;
  const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

  console.log('── 短任务：启动→完成 ──');
  const r1 = taskRunner.start('echo-test', 'node -e "console.log(1); console.log(2)"');
  ok('短任务启动返回 ok', r1.ok);
  await sleep(1000);
  const t1 = taskRunner.get('echo-test')!;
  ok('短任务状态 done', t1.status === 'done');
  ok('短任务退出码 0', t1.exitCode === 0);
  ok('短任务 stdout 含 1 和 2', t1.stdout.includes('1') && t1.stdout.includes('2'));

  console.log('── 长任务：运行中 → switch → kill ──');
  const r2 = taskRunner.start('long-run', 'node -e "setInterval(()=>console.log(\'tick-\'+Date.now()), 100)"');
  ok('长任务启动 ok', r2.ok);
  await sleep(700);
  const t2 = taskRunner.get('long-run')!;
  ok('长任务状态 running', t2.status === 'running');
  ok('长任务有输出累积', t2.stdout.length > 0);

  const sw = await taskSwitchTool.execute({ taskName: 'long-run' });
  ok('task_switch 显示 running', sw.toString().includes('running'));
  ok('task_switch 输出含 tick', sw.toString().includes('tick'));

  const k = await taskKillTool.execute({ taskName: 'long-run' });
  ok('task_kill 返回成功', k.toString().includes('终止信号'));
  await sleep(700);
  const t2b = taskRunner.get('long-run')!;
  ok('kill 后状态 killed', t2b.status === 'killed');

  console.log('── 列表 ──');
  const lst = await taskListTool.execute({});
  const lstText = lst.toString();
  ok('task_list 含两个任务', lstText.includes('echo-test') && lstText.includes('long-run'));
  ok('task_list 含状态标记', lstText.includes('[done]') && lstText.includes('[killed]'));
  const bulkList = (lst as any).rawBulk;
  ok('task_list bulk tasks 长度 2', Array.isArray(bulkList.tasks) && bulkList.tasks.length === 2);

  console.log('── 同名拒绝 ──');
  const dup = await taskExecuteTool.execute({ command: 'node -e "console.log(1)"', taskName: 'echo-test' });
  ok('同名任务被拒绝', dup.toString().includes('已存在'));

  console.log('── 错误路径 ──');
  const miss = await taskSwitchTool.execute({ taskName: 'nope' });
  ok('switch 不存在任务报错', miss.toString().includes('未找到任务'));
  const killDone = await taskKillTool.execute({ taskName: 'echo-test' });
  ok('kill 已结束任务报错', killDone.toString().includes('已结束'));
  const killMiss = await taskKillTool.execute({ taskName: 'nope' });
  ok('kill 不存在任务报错', killMiss.toString().includes('未找到任务'));

  console.log(`\n🎉 全部通过（${pass} 项断言）`);
}

main().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
