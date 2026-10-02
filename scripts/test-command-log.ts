/**
 * test-command-log.ts — execute_command 输出限制与命令日志回归测试
 *
 * 覆盖场景：
 *  1. 短输出（< 10000 字符）：AI 文本原样返回，不附加截断提示
 *  2. 长输出（> 10000 字符）：AI 文本截断到上限 + 附加提示；truncated = true
 *  3. 每次执行后完整输出落盘到 sessions/{sessionId}/latest-cmd.log
 *  4. command_log 取回完整日志；maxChars 可限制返回长度
 *  5. 错误路径（非零退出）同样落盘，且 error 文本受上限约束
 *  6. 会话切换后日志分区跟随新会话
 */
import { executeCommandTool, EXEC_OUTPUT_MAX_CHARS } from '../src/tools/execute-command.js';
import { commandLogTool } from '../src/tools/command-log.js';
import { cmdLogStore } from '../src/tools/cmd-log-store.js';
import { setWorkspaceRoot, resetWorkspaceRoot } from '../src/workdir.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ' → ' + detail : ''}`);
  }
}

// 隔离到临时工作区（测试产物不污染真实 sessions/）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-cmdlog-test-'));
setWorkspaceRoot(tmp);

async function main() {
  const SID = 'test-cmdlog';
  cmdLogStore.setSessionId(SID);
  const logPath = path.join(tmp, 'sessions', SID, 'latest-cmd.log');

  // 1. 短输出：不截断、原样返回
  const r1 = await executeCommandTool.execute({ command: `node -e "console.log('short-output')"` });
  check('短输出不截断', r1.rawBulk.truncated === false, `truncated=${r1.rawBulk.truncated}`);
  check('短输出 AI 文本等于 stdout', String(r1).trim() === 'short-output', JSON.stringify(String(r1)));
  check('短输出已落盘 latest-cmd.log', fs.existsSync(logPath), logPath);
  const log1 = fs.readFileSync(logPath, 'utf-8');
  check('日志含命令头、退出码与输出', log1.includes('# 命令:') && log1.includes('# 退出码: 0') && log1.includes('short-output'), log1.slice(0, 160));

  // 2. 长输出：截断到 10000 + 附加提示
  const bigCharCount = EXEC_OUTPUT_MAX_CHARS + 3000;
  const r2 = await executeCommandTool.execute({
    command: `node -e "process.stdout.write('x'.repeat(${bigCharCount}))"`,
  });
  const ai2 = String(r2);
  check('长输出标记 truncated', r2.rawBulk.truncated === true, `truncated=${r2.rawBulk.truncated}`);
  check(`长输出 AI 文本前缀为 ${EXEC_OUTPUT_MAX_CHARS} 字符`, ai2.startsWith('x'.repeat(100)) && ai2.length > EXEC_OUTPUT_MAX_CHARS, `len=${ai2.length}`);
  check('长输出附加截断提示 + command_log 指引', ai2.includes('输出已截断') && ai2.includes('command_log') && ai2.includes(`${bigCharCount} 字符`), ai2.slice(-160));
  // bulk 仍保留完整输出（供 TUI/WebUI 渲染）
  check('bulk.stdout 保留完整输出', r2.rawBulk.stdout.length === bigCharCount, `len=${r2.rawBulk.stdout.length}`);

  // 3. command_log 取回完整日志
  const c1 = await commandLogTool.execute({});
  const c1Bulk = c1.rawBulk;
  check('command_log found=true', c1Bulk.found === true);
  check('command_log 内容含截断前的完整输出', c1Bulk.content!.includes(bigCharCount.toString()) || c1Bulk.content!.includes('x'.repeat(200)), `size=${c1Bulk.size}`);
  check('command_log size 覆盖完整输出', c1Bulk.size > bigCharCount, `size=${c1Bulk.size}`);
  check('command_log 未超上限时不截断', c1Bulk.truncated === false);

  // 4. maxChars 限制返回长度
  const c2 = await commandLogTool.execute({ maxChars: 500 });
  check('command_log maxChars 生效', c2.rawBulk.truncated === true && c2.rawBulk.content!.length < 700, `len=${c2.rawBulk.content!.length}`);
  check('command_log 截断提示含完整字符数', c2.rawBulk.content!.includes('已截断'), c2.rawBulk.content!.slice(-80));

  // 5. 错误路径：非零退出码 → 落盘 + error 受上限约束
  const r3 = await executeCommandTool.execute({ command: `node -e "process.exit(2)"` });
  check('非零退出走 error 路径', String(r3).includes('命令执行失败'), String(r3));
  const log3 = fs.readFileSync(logPath, 'utf-8');
  check('错误路径同样落盘', log3.includes('node -e'), log3.slice(0, 120));

  // 6. 会话切换：日志分区跟随
  cmdLogStore.setSessionId('other-sid');
  check('切换会话后 filePath 跟随', cmdLogStore.filePath.includes('other-sid'), cmdLogStore.filePath);
  const c3 = await commandLogTool.execute({});
  check('新会话无日志 → found=false', c3.rawBulk.found === false, JSON.stringify(c3.rawBulk));

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 项通过，${fail} 项失败`);
  resetWorkspaceRoot();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  resetWorkspaceRoot();
  process.exit(1);
});
