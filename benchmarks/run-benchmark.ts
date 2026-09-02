/**
 * benchmarks/run-benchmark.ts — 批量跑分入口
 *
 * 用法：
 *   tsx benchmarks/run-benchmark.ts [--tasks <tasks.json>] [--filter <id子串>] [--keep]
 *
 * 行为：
 *   1. 读取任务清单（默认 benchmarks/tasks.json）
 *   2. 每个任务：把 benchmarks/fixtures/<id> 复制到仓库外临时目录
 *      （避免外层 package.json 的 "type":"module" 等仓库环境干扰任务）
 *   3. 独立子进程跑 benchmarks/run-local-task.ts（headless 驱动 seek-agent 干活）
 *   4. 子进程结束后在任务工作区执行 grader（cmd + 退出码 + 输出子串）判定 pass/fail
 *   5. 归档现场到 benchmarks/run-output/<runId>/<taskId>/，并写 report.json
 *
 * 环境变量：BENCH_GET 继承给子进程（含 BENCH_TIMEOUT_SEC 覆盖）。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── 类型 ──

interface BenchTask {
  id: string;
  instruction: string;
  timeoutSec: number;
  grader: { cmd: string; expectExit?: number; expectOutput?: string[] };
}

interface TaskResult {
  taskId: string;
  pass: boolean;
  reason: string;
  elapsedMs: number;
  toolCallCount: number;
  usageSummary: Record<string, unknown> | null;
  assistantText: string;
  toolLog: Array<{ toolName: string; args: unknown; result: string }>;
  graderOutput: string;
}

// ── 常量 ──

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(ROOT, 'benchmarks', 'fixtures');
const OUTPUT_DIR = path.join(ROOT, 'benchmarks', 'run-output');
const RUN_ID = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const AGENT_ENTRY = path.join(ROOT, 'benchmarks', 'run-local-task.ts');

// ── 小工具 ──

function runChild(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; shell?: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut: false });
    });
  });
}

function parseBenchResult(stdout: string): Record<string, any> | null {
  const line = stdout.split('\n').find((l) => l.startsWith('##BENCH_RESULT##'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('##BENCH_RESULT##'.length));
  } catch {
    return null;
  }
}

function copyDir(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// ── 单任务 ──

async function runOne(
  task: BenchTask,
  tmpWs: string,
  taskOutDir: string,
): Promise<TaskResult> {
  const result: TaskResult = {
    taskId: task.id,
    pass: false,
    reason: 'pending',
    elapsedMs: 0,
    toolCallCount: 0,
    usageSummary: null,
    assistantText: '',
    toolLog: [],
    graderOutput: '',
  };

  // 1. 复制种子工作区到临时目录（仓库外，规避外层 package.json 等干扰）
  copyDir(path.join(FIXTURES_DIR, task.id), tmpWs);

  // 2. 驱动 seek-agent 干活（独立进程，任务间状态天然隔离）
  const started = Date.now();
  const agentRun = await runChild(
    process.execPath,
    ['--import', 'tsx', AGENT_ENTRY, tmpWs, task.instruction],
    {
      cwd: ROOT,
      env: { ...process.env, BENCH_TIMEOUT_SEC: String(task.timeoutSec) },
      timeoutMs: (task.timeoutSec + 120) * 1000, // 兜底：比 agent 内部超时多 2 分钟用于收尾
    },
  );
  result.elapsedMs = Date.now() - started;

  const bench = parseBenchResult(agentRun.stdout);
  if (!bench) {
    result.reason = `无法解析 run-local-task 输出 (exit=${agentRun.code}, stdout=${agentRun.stdout.slice(-300)}, stderr=${agentRun.stderr.slice(-300)})`;
    archive();
    return result;
  }
  result.toolCallCount = bench.toolCallCount ?? 0;
  result.usageSummary = bench.usageSummary ?? null;
  result.assistantText = bench.assistantText ?? '';
  result.toolLog = bench.toolLog ?? [];

  if (bench.status !== 'done') {
    result.reason = `agent 超时中断 (${task.timeoutSec}s)`;
    archive();
    return result;
  }

  // 3. 判定：在任务工作区执行 grader
  const grade = await runChild(task.grader.cmd, [], { cwd: tmpWs, env: process.env, timeoutMs: 60000, shell: true });
  result.graderOutput = (grade.stdout + grade.stderr).slice(0, 2000);

  const expectExit = task.grader.expectExit ?? 0;
  const expectOutput = task.grader.expectOutput ?? [];
  const exitOk = grade.code === expectExit;
  const outOk = expectOutput.every((sub) => result.graderOutput.includes(sub));
  if (exitOk && outOk) {
    result.pass = true;
    result.reason = 'PASS';
  } else {
    const bits: string[] = [];
    if (!exitOk) bits.push(`退出码 ${grade.code} ≠ ${expectExit}`);
    if (!outOk) bits.push(`输出缺期望子串 ${expectOutput.join(', ')}`);
    result.reason = `FAIL: ${bits.join('; ')}`;
  }

  archive();

  // 4. 归档现场（临时目录拷回现成目录）
  function archive(): void {
    try {
      copyDir(tmpWs, path.join(taskOutDir, 'workspace'));
      fs.writeFileSync(path.join(taskOutDir, 'result.json'), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(taskOutDir, 'agent-stdout.txt'), agentRun.stdout);
      fs.writeFileSync(path.join(taskOutDir, 'agent-stderr.txt'), agentRun.stderr);
    } catch {
      /* 归档失败不影响判定结果 */
    }
  }

  return result;
}

// ── 主流程 ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tasksFile = args.find((a, i) => a === '--tasks' && args[i + 1]) ? args[args.indexOf('--tasks') + 1] : path.join(ROOT, 'benchmarks', 'tasks.json');
  const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : null;

  const raw = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
  let tasks: BenchTask[] = raw.tasks ?? [];
  if (filter) tasks = tasks.filter((t) => t.id.includes(filter));
  if (tasks.length === 0) {
    console.error(`没有匹配的任务（filter=${filter}）`);
    process.exit(2);
  }

  const runDir = path.join(OUTPUT_DIR, RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`运行目录: ${runDir}\n任务数: ${tasks.length}\n`);

  const results: TaskResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const tmpWs = path.join(os.tmpdir(), 'seek-bench', task.id);
    const taskOutDir = path.join(runDir, task.id);
    fs.mkdirSync(taskOutDir, { recursive: true });

    console.log(`[${i + 1}/${tasks.length}] ${task.id} ...`);
    const r = await runOne(task, tmpWs, taskOutDir);
    results.push(r);
    const mark = r.pass ? '✅ PASS' : `❌ ${r.reason}`;
    console.log(`    ${mark}  (${(r.elapsedMs / 1000).toFixed(1)}s, ${r.toolCallCount} tools)\n`);
  }

  // ── 汇总 ──
  const passed = results.filter((r) => r.pass).length;
  const avgMs = results.length ? Math.round(results.reduce((s, r) => s + r.elapsedMs, 0) / results.length) : 0;
  const totalIn = results.reduce((s, r) => s + ((r.usageSummary?.inputTokens as number) ?? 0), 0);
  const totalOut = results.reduce((s, r) => s + ((r.usageSummary?.outputTokens as number) ?? 0), 0);
  const totalCache = results.reduce((s, r) => s + ((r.usageSummary?.cacheReadTokens as number) ?? 0), 0);

  const report = {
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    model: process.env.OPENAI_MODEL ?? null,
    taskCount: tasks.length,
    solved: passed,
    solvedRate: tasks.length ? +(passed / tasks.length).toFixed(4) : 0,
    avgElapsedMs: avgMs,
    totals: { inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: totalCache },
    results: results.map(({ pass, taskId, reason, elapsedMs, toolCallCount }) => ({
      taskId, pass, reason, elapsedMs, toolCallCount,
    })),
  };
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));

  console.log('────────── 汇总 ──────────');
  for (const r of results) {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.taskId}  ${r.pass ? 'PASS' : r.reason}  (${(r.elapsedMs / 1000).toFixed(1)}s, ${r.toolCallCount} tools)`);
  }
  console.log(`\n得分: ${passed}/${tasks.length} (${((passed / tasks.length) * 100).toFixed(1)}%)`);
  console.log(`平均耗时: ${(avgMs / 1000).toFixed(1)}s | 总 input ${totalIn} / output ${totalOut} / cacheRead ${totalCache}`);
  console.log(`报告: ${path.join(runDir, 'report.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});