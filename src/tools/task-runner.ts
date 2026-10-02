/**
 * task-runner.ts — 后台任务管理器
 *
 * 提供后台/并行执行命令的能力，与 execute_command（同步等待）互补：
 *   - task_execute 提交命令后立即返回，进程在后台运行
 *   - 输出在内存中持续累积（每流保留最近 MAX_BUF 字符，防长跑任务吃爆内存）
 *   - task_switch 随时查看某个任务的运行状态与最新输出
 *   - task_list 列出所有任务（含状态/时长/输出量）
 *   - task_kill 终止任务（Windows 下 taskkill /T 连子进程树一起杀）
 *
 * 注意：后台任务没有超时限制，误启动的常驻命令必须用 task_kill 手动终止。
 */
import { tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import { getCwd } from '../workdir.js';
import { decodeSmart } from './execute-command';
import { ToolOutput } from './tool-output';
import type { TaskBulk, TaskStatus } from './raw-bulk-types';

/** 每个输出流保留的最近字符数上限 */
const MAX_BUF = 20_000;

export interface TaskInfo {
  name: string;
  command: string;
  status: TaskStatus;
  pid?: number;
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
  stdout: string;
  stderr: string;
  error?: string;
}

class TaskRunner {
  private tasks = new Map<string, TaskInfo>();
  private children = new Map<string, import('child_process').ChildProcess>();

  /** 清理一条已结束任务的残留记录（允许同名复用名字）。
   *  只处理非 running 任务；若此处仍有未 close 的子进程句柄（如刚 task_kill、
   *  close 事件尚未到达的窗口期），摘除其事件监听并释放引用，
   *  避免迟到的 close 事件误删同名新任务的句柄。 */
  private dispose(name: string) {
    const task = this.tasks.get(name);
    if (!task || task.status === 'running') return;
    this.tasks.delete(name);
    const child = this.children.get(name);
    if (child) {
      child.removeAllListeners();
      this.children.delete(name);
    }
  }

  /** 启动后台任务：running 同名拒绝，已结束的同名任务清理后复用名字重建 */
  start(name: string, command: string): { ok: true; task: TaskInfo } | { ok: false; error: string } {
    const existed = this.tasks.get(name);
    if (existed) {
      // running 任务禁止重名（避免覆盖正在运行的输出）；已结束任务允许同名复用，先清理旧记录
      if (existed.status === 'running') {
        return { ok: false, error: `任务 "${name}" 正在运行中（${existed.command}），请先 task_kill 或换一个任务名` };
      }
      this.dispose(name);
    }

    const task: TaskInfo = {
      name,
      command,
      status: 'running',
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
    };
    this.tasks.set(name, task);

    const child = spawn(command, {
      shell: true,
      cwd: getCwd(),
      // 与 execute_command 一致：让 Python 子进程输出 UTF-8（配合智能解码）且无缓冲，
      // 否则长任务（如 Python 脚本）运行期间输出滞留进程内，task_switch 看不到中间进度
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    task.pid = child.pid ?? undefined;
    this.children.set(name, child);

    child.stdout?.on('data', (chunk: Buffer) => { task.stdout = appendOutput(task.stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { task.stderr = appendOutput(task.stderr, chunk); });

    child.on('error', (err) => {
      // spawn 本身失败（如命令不存在、shell 无法启动）
      task.status = 'failed';
      task.error = err.message;
      task.endedAt = Date.now();
      this.children.delete(name);
    });

    child.on('close', (code, signal) => {
      task.exitCode = code;
      task.endedAt = Date.now();
      // Windows 下 taskkill /F 杀的进程 close 事件 signal 可能为 null，
      // 但 kill() 已主动标记 killed，这里保留该状态
      task.status = (signal || task.status === 'killed') ? 'killed' : (code === 0 ? 'done' : 'failed');
      this.children.delete(name);
    });

    return { ok: true, task };
  }
  /**
   * 接管一个已在运行的子进程（execute_command 超时转后台时调用）。
   * child 必须尚未 close；已有输出经 seed 迁入任务记录，后续输出继续累积。
   */
  adopt(
    name: string,
    command: string,
    child: import('child_process').ChildProcess,
    seed: { stdout: string; stderr: string },
    startedAt: number = Date.now(),
  ): { ok: true; task: TaskInfo } | { ok: false; error: string } {
    const existed = this.tasks.get(name);
    if (existed) {
      return {
        ok: false,
        error: existed.status === 'running'
          ? `任务 "${name}" 正在运行中，无法接管`
          : `任务 "${name}" 已存在（状态 ${existed.status}），无法接管`
      };
    }

    const task: TaskInfo = {
      name,
      command,
      status: 'running',
      startedAt,
      stdout: seed.stdout,
      stderr: seed.stderr,
    };
    this.tasks.set(name, task);

    // 暂停流 → 摘掉原监听器 → 挂 TaskRunner 的 → 恢复
    // （pause/resume 保证接管窗口期的数据不会丢失）
    child.stdout?.pause();
    child.stderr?.pause();
    child.removeAllListeners();
    child.stdout?.on('data', (chunk: Buffer) => { task.stdout = appendOutput(task.stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { task.stderr = appendOutput(task.stderr, chunk); });
    child.on('error', (err) => {
      task.status = 'failed';
      task.error = err.message;
      task.endedAt = Date.now();
      this.children.delete(name);
    });
    child.on('close', (code, signal) => {
      task.exitCode = code;
      task.endedAt = Date.now();
      task.status = (signal || task.status === 'killed') ? 'killed' : (code === 0 ? 'done' : 'failed');
      this.children.delete(name);
    });
    child.stdout?.resume();
    child.stderr?.resume();

    this.children.set(name, child);
    return { ok: true, task };
  }

  get(name: string): TaskInfo | undefined {
    return this.tasks.get(name);
  }

  all(): TaskInfo[] {
    return [...this.tasks.values()];
  }

  /** 终止任务；Windows 下 taskkill /T 连子进程树一起杀，Unix 下 SIGTERM */
  kill(name: string): { ok: true } | { ok: false; error: string } {
    const task = this.tasks.get(name);
    if (!task) return { ok: false, error: `未找到任务 "${name}"` };
    if (task.status !== 'running') return { ok: false, error: `任务 "${name}" 已结束（${task.status}），无需停止` };

    const child = this.children.get(name);
    if (!child?.pid) return { ok: false, error: `任务 "${name}" 没有可终止的进程句柄` };

    const pid = child.pid;
    if (process.platform === 'win32') {
      // 后台任务经 cmd 启动，直接 kill 只杀 shell，子进程会残留 → 用 taskkill 杀整棵进程树
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    // 立即标记 killed，close 事件到达前状态就可见（Windows taskkill 的 close signal 可能为 null）
    task.status = 'killed';
    return { ok: true };
  }

  /** 等待任务结束，最多 timeoutMs 毫秒。
   *  返回 true=任务已结束/不存在；false=等待超时仍在运行。
   *  close 事件监听为主 + 周期性状态兜底，避免监听注册前进程已退出的竞态。 */
  waitForDone(name: string, timeoutMs: number): Promise<boolean> {
    const task = this.tasks.get(name);
    if (!task || task.status !== 'running') return Promise.resolve(true);
    const child = this.children.get(name);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let iv: ReturnType<typeof setInterval>;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(iv);
        child?.removeListener('close', onClose);
        child?.removeListener('error', onError);
        resolve(ok);
      };
      const onClose = () => finish(true);
      const onError = () => finish(true);
      timer = setTimeout(() => finish(false), timeoutMs);
      iv = setInterval(() => {
        const cur = this.tasks.get(name);
        if (!cur || cur.status !== 'running') finish(true);
      }, 150);
      child?.once('close', onClose);
      child?.once('error', onError);
      // 兜底：状态检查与监听注册之间的窗口期任务可能已结束
      const cur = this.tasks.get(name);
      if (!cur || cur.status !== 'running') finish(true);
    });
  }
}

function appendOutput(current: string, chunk: Buffer): string {
  const text = decodeSmart(chunk);
  if (!text) return current;
  const combined = current + text;
  return combined.length > MAX_BUF ? combined.slice(-MAX_BUF) : combined;
}

export const taskRunner = new TaskRunner();

/** 任务摘要（list 用） */
function toSummary(t: TaskInfo) {
  const durationMs = t.endedAt ? t.endedAt - t.startedAt : Date.now() - t.startedAt;
  return {
    name: t.name,
    command: t.command,
    status: t.status,
    running: t.status === 'running',
    exitCode: t.exitCode ?? null,
    startedAt: t.startedAt,
    durationMs,
    stdoutChars: t.stdout.length,
    stderrChars: t.stderr.length,
  };
}

/** 组合 stdout+stderr，取尾部 tail 字符 */
function tailOutput(t: TaskInfo, tail: number): { text: string; truncated: boolean } {
  const combined = t.stdout + (t.stderr ? `\n[stderr]: ${t.stderr}` : '');
  if (combined.length <= tail) return { text: combined, truncated: false };
  return { text: combined.slice(-tail), truncated: true };
}

// ── 工具 ──

export const taskExecuteTool = tool({
  description: [
    '在后台启动一条命令并立即返回（不等待执行完成），适合长耗时、需要并行跑多个的任务。',
    '命令在后台持续运行，输出会持续累积，可随时用 task_switch 查看该任务的最新输出、用 task_list 看全部任务状态。',
    'taskName 是任务唯一标识（后续用 task_switch / task_list / task_kill 引用），同名任务需先 task_kill 或换名。',
    '注意：后台任务没有超时限制，误启动的常驻命令（如 dev server）要记得用 task_kill 终止。',
  ].join(' '),
  inputSchema: z.object({
    command: z.string().describe('要在后台执行的命令（与 execute_command 相同语义，由系统 shell 解析）'),
    taskName: z.string().describe('任务名称（唯一标识，仅用于本会话内引用）'),
  }),
  execute: async ({ command, taskName }) => {
    const result = taskRunner.start(taskName, command);
    if (!result.ok) {
      const bulk: TaskBulk = { type: 'task', action: 'execute', taskName, command, error: result.error };
      return new ToolOutput(bulk, `❌ ${result.error}`);
    }
    const t = result.task;
    const bulk: TaskBulk = {
      type: 'task', action: 'execute', taskName, command,
      status: t.status, pid: t.pid, stdoutChars: 0,
    };
    return new ToolOutput(bulk, `🚀 后台任务已启动："${taskName}"（PID ${t.pid ?? '?'}，工作区 ${getCwd()}）\n命令：${command}\n可随时用 task_switch(taskName="${taskName}") 查看输出，task_kill(taskName="${taskName}") 停止它。`);
  },
});

export const taskSwitchTool = tool({
  description: [
    '查看指定后台任务的最新运行状态与输出尾部（把注意力"切"到该任务）。',
    '返回任务状态（running/done/failed/killed）、退出码、输出总长度，以及最近的输出片段（默认尾部 3000 字符，可用 tail 调整）。',
    '配合 task_execute 使用：任务还在跑就定期 task_switch 轮询，任务结束则拿到完整结果。',
  ].join(' '),
  inputSchema: z.object({
    taskName: z.string().describe('要查看的任务名称（task_execute 时指定的 taskName）'),
    tail: z.number().int().min(100).max(20000).optional().describe('返回输出尾部字符数，默认 3000'),
    wait: z.number().int().min(1).max(60).optional()
      .describe('（可选）强制等待秒数：任务仍在运行则阻塞等待其结束（封顶 60 秒）后返回完整输出；等待超时则返回当前进度并在结果中标注。用于拿不到输出时一次等到底'),
  }),
  execute: async ({ taskName, tail, wait }) => {
    let t = taskRunner.get(taskName);
    if (!t) {
      const bulk: TaskBulk = { type: 'task', action: 'switch', taskName, error: `未找到任务 "${taskName}"` };
      return new ToolOutput(bulk, `❌ 未找到任务 "${taskName}"，可用 task_list 查看全部任务。`);
    }
    // 强制等待：任务仍在运行时阻塞至其结束（最多 wait 秒，封顶 60），期间 Agent 主进程暂停
    let waitTimedOut = false;
    if (wait && wait > 0 && t.status === 'running') {
      waitTimedOut = !(await taskRunner.waitForDone(taskName, Math.min(wait, 60) * 1000));
      t = taskRunner.get(taskName)!;
    }
    const tailLen = tail ?? 3000;
    const { text, truncated } = tailOutput(t, tailLen);
    const durationMs = t.endedAt ? t.endedAt - t.startedAt : Date.now() - t.startedAt;
    const statusIcon = t.status === 'running' ? '🔄' : t.status === 'done' ? '✅' : t.status === 'killed' ? '⏹' : '❌';
    const waitNote = waitTimedOut ? '，等待超时仍未结束' : '';
    const head = `${statusIcon} 任务 "${taskName}"：${t.status}（时长 ${(durationMs / 1000).toFixed(1)}s${t.exitCode != null ? `，退出码 ${t.exitCode}` : ''}${waitNote}，stdout ${t.stdout.length} 字符）`;
    const body = text ? `\n--- 输出（尾部 ${truncated ? '截断' : '全部'}）---\n${text}` : '\n（暂无输出）';
    const bulk: TaskBulk = {
      type: 'task', action: 'switch', taskName,
      status: t.status, exitCode: t.exitCode ?? null,
      output: text, outputTruncated: truncated, stdoutChars: t.stdout.length,
      waitTimedOut,
    };
    return new ToolOutput(bulk, head + body);
  },
});

export const taskListTool = tool({
  description: '列出所有后台任务（含运行中与已结束的）：任务名、状态、命令、运行时长、退出码、输出量。运行中任务会标记 🔄。',
  inputSchema: z.object({}),
  execute: async () => {
    const all = taskRunner.all();
    if (all.length === 0) {
      const bulk: TaskBulk = { type: 'task', action: 'list', tasks: [] };
      return new ToolOutput(bulk, '📭 当前没有任何后台任务。可用 task_execute(command=..., taskName=...) 启动一个。');
    }
    const lines = all.map((t, i) => {
      const icon = t.status === 'running' ? '🔄' : t.status === 'done' ? '✅' : t.status === 'killed' ? '⏹' : '❌';
      const dur = ((t.endedAt ? t.endedAt - t.startedAt : Date.now() - t.startedAt) / 1000).toFixed(1);
      const exit = t.exitCode != null ? `，退出码 ${t.exitCode}` : '';
      return `${i + 1}. ${icon} ${t.name} [${t.status}]（${dur}s${exit}，输出 ${t.stdout.length + t.stderr.length} 字符）\n    ↳ ${t.command}`;
    });
    const msg = `📋 后台任务（共 ${all.length} 个）：\n${lines.join('\n')}`;
    const bulk: TaskBulk = { type: 'task', action: 'list', tasks: all.map(toSummary) };
    return new ToolOutput(bulk, msg);
  },
});

export const taskKillTool = tool({
  description: '终止一个正在运行的后台任务。Windows 下会连同子进程树一起杀掉（taskkill /T /F）。已结束的任务无需也不能停止。',
  inputSchema: z.object({
    taskName: z.string().describe('要终止的任务名称（task_execute 时指定的 taskName）'),
  }),
  execute: async ({ taskName }) => {
    const result = taskRunner.kill(taskName);
    if (!result.ok) {
      const bulk: TaskBulk = { type: 'task', action: 'kill', taskName, error: result.error };
      return new ToolOutput(bulk, `❌ ${result.error}`);
    }
    const bulk: TaskBulk = { type: 'task', action: 'kill', taskName, status: 'killed' };
    return new ToolOutput(bulk, `⏹ 已发送终止信号给任务 "${taskName}"（退出后状态会变为 killed）。`);
  },
});







