/**
 * benchmarks/run-local-task.ts — 跑分单任务进程入口
 *
 * 用法：
 *   tsx benchmarks/run-local-task.ts <workspaceDir> <instruction>
 *
 * 环境变量：
 *   BENCH_TIMEOUT_SEC   单任务超时秒数（默认 300），超时走安全中断
 *   模型/密钥沿用项目 .env（OPENAI_MODEL、DEEPSEEK_API_KEY 等）
 *
 * 流程：
 *   1. 工作区沙箱切到任务目录（agent 的文件工具/命令全部限制在该目录内）
 *   2. 构造 HeadlessUI + CLIAAgent，推送 instruction 并等待处理完毕
 *   3. 超时则通过 ui.abort() 触发安全停止（与 WebUI 中断同路径）
 *   4. 输出一行 ##BENCH_RESULT## JSON（便于上层 harness 汇总），强制退出
 *
 * 每个任务独立进程运行：任务间全局状态天然隔离，不会互相污染。
 */
import 'dotenv/config';
import { CLIAAgent } from '../src/agent';
import { HeadlessUI } from './headless-ui';
import { setWorkspaceRootOnly } from '../src/workdir';
import { subAgentManager } from '../src/tools/inner_skills/sub-agent/manager';
import * as fs from 'node:fs';
import * as path from 'node:path';

function fatal(msg: string, code = 1): never {
  console.error(`[run-local-task] ${msg}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const [, , workspaceArg, instruction] = process.argv;
  if (!workspaceArg || !instruction) {
    console.error('用法: tsx benchmarks/run-local-task.ts <workspaceDir> <instruction>');
    process.exit(2);
  }

  const workspaceDir = path.resolve(workspaceArg);
  if (!fs.existsSync(workspaceDir)) fatal(`任务工作区不存在: ${workspaceDir}`, 2);

  const timeoutSec = Number(process.env.BENCH_TIMEOUT_SEC || 300);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) fatal(`BENCH_TIMEOUT_SEC 非法: ${timeoutSec}`);

  // 沙箱切到任务目录，agent 全部工具/命令被限制在此
  setWorkspaceRootOnly(workspaceDir);

  const ui = new HeadlessUI();
  const agent = new CLIAAgent(ui as any, undefined);

  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ui.abort();
  }, timeoutSec * 1000);

  try {
    await agent.run(instruction);
  } catch (err) {
    fatal(`agent.run 抛错: ${(err as Error)?.message ?? err}`);
  } finally {
    clearTimeout(timer);
    // 停掉可能的后台 instructor 流（跑分不启用，防御性清理）
    subAgentManager.abortAllInstructors();
  }

  const result = {
    status: timedOut ? 'timeout' : 'done',
    elapsedMs: Date.now() - startedAt,
    toolCallCount: ui.toolCallCount,
    usageSummary: ui.usageSummary,
    assistantText: ui.assistantText.slice(0, 2000),
    toolLog: ui.toolLog.map((t) => ({
      toolName: t.toolName,
      args: t.args,
      result: String(t.result).slice(0, 300),
    })),
  };

  console.log('##BENCH_RESULT##' + JSON.stringify(result));
  // 强制退出：tokenizer python 子进程等长驻句柄不阻塞跑分管线
  process.exit(0);
}

main().catch((err) => fatal((err as Error)?.message ?? String(err)));