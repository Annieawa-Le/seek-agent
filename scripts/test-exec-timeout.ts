/**
 * test-exec-timeout.ts — execute_command 超时保护回归测试
 *
 * 覆盖场景：
 *  1. 快命令正常完成（< 时限）：exitCode 0 + stdout 智能解码
 *  2. 慢命令但仍在时限内：正常完成
 *  3. 超时（> EXEC_TIMEOUT_MS）→ 自动转入后台任务：
 *     deferred 标记 + taskName；taskRunner 可查且 running；
 *     进程自然结束后任务 done，转后台前的 seed 输出与后续输出完整累积
 *  4. 非零退出码 → error 路径（与原 exec 抛错语义一致）
 *  5. 命令不存在 → error 路径（stderr 内容进入 error）
 *  6. task_switch 可查看转后台任务的输出
 */
import { executeCommandTool } from '../src/tools/execute-command.js';
import { taskRunner, taskSwitchTool } from '../src/tools/task-runner.js';

// 加速超时：1 秒即触发转后台（生产默认 60_000）
process.env.EXEC_TIMEOUT_MS = '1000';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${detail ? '→ ' + detail : ''}`);
  }
}

/** 轮询等待后台任务结束（最多 timeoutMs） */
async function waitTaskDone(taskName: string, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = taskRunner.get(taskName);
    if (t && t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  return taskRunner.get(taskName);
}

async function main() {
  // 1. 快命令正常完成
  const r1 = await executeCommandTool.execute({ command: `node -e "console.log('中文测试ABC')"` });
  const b1 = r1.rawBulk;
  check('快命令 exitCode=0', b1.exitCode === 0, `实际: ${b1.exitCode}`);
  check('快命令 stdout 解码正确', b1.stdout.trim() === '中文测试ABC', `实际: ${b1.stdout}`);
  check('快命令无 deferred 标记', b1.deferred !== true, `deferred=${b1.deferred}`);

  // 2. 慢命令但仍在时限内：正常完成
  const r2 = await executeCommandTool.execute({ command: `node -e "setTimeout(()=>{ console.log('slow-done') }, 300)"` });
  const b2 = r2.rawBulk;
  check('时限内慢命令正常完成', b2.exitCode === 0 && b2.stdout.includes('slow-done'), `exitCode=${b2.exitCode} stdout=${b2.stdout}`);
  check('时限内慢命令未转后台', b2.deferred !== true, `deferred=${b2.deferred}`);

  // 3. 超时 → 转后台（命令 2 秒完成，1 秒触发转后台）
  const r3 = await executeCommandTool.execute({ command: `node -e "console.log('before'); setTimeout(()=>{ console.log('after') }, 2000)"` });
  const b3: any = r3.rawBulk;
  check('超时转后台 deferred=true', b3.deferred === true, `deferred=${b3.deferred}`);
  check('转后台 taskName 非空', typeof b3.taskName === 'string' && b3.taskName.length > 0, `taskName=${b3.taskName}`);
  check('超时时限字段为 1000ms', b3.timeoutMs === 1000, `timeoutMs=${b3.timeoutMs}`);
  const t3 = taskRunner.get(b3.taskName);
  check('任务已注册且 running', !!t3 && t3.status === 'running', `status=${t3?.status}`);
  check('seed 输出已迁入（before）', !!t3 && t3.stdout.includes('before'), `stdout=${t3?.stdout}`);
  const aiText3 = String(r3);
  check('AI 文本提示转后台与查看方式', aiText3.includes('已转入后台任务') && aiText3.includes(b3.taskName) && aiText3.includes('task_switch'), aiText3);

  // 等自然结束，验证继续累积
  const ended = await waitTaskDone(b3.taskName);
  check('后台任务最终 done', !!ended && ended.status === 'done', `status=${ended?.status}`);
  check('seed 之后输出继续累积（after）', !!ended && ended.stdout.includes('after'), `stdout=${ended?.stdout}`);

  // 6. task_switch 可查看转后台任务
  const sw = await taskSwitchTool.execute({ taskName: b3.taskName, tail: 1000 });
  const swText = String(sw);
  check('task_switch 可查转后台任务', swText.includes('done') && swText.includes('after') && swText.includes('before'), swText.slice(0, 200));

  // 4. 非零退出码 → error 路径
  const r4 = await executeCommandTool.execute({ command: `node -e "process.exit(3)"` });
  const b4: any = r4.rawBulk;
  check('非零退出走 error', typeof b4.error === 'string' && b4.error.includes('命令退出码 3'), `error=${b4.error}`);
  check('非零退出 AI 文本带失败前缀', String(r4).includes('命令执行失败'), String(r4));

  // 5. 命令不存在 → error 路径（stderr 内容）
  const r5 = await executeCommandTool.execute({ command: 'nonexistent-cmd-xyz-123' });
  const b5: any = r5.rawBulk;
  check('不存在命令 error 非空', typeof b5.error === 'string' && b5.error.length > 0, `error=${b5.error}`);

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 项通过，${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});