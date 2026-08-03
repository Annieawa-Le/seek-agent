/**
 * run.ts — ts-debug 公共子进程执行器
 *
 * 直接 spawn Node 可执行文件（不经 cmd shell），参数不拼命令行，
 * 输出按 UTF-8 收集——避免 Windows 管道对中文输出的乱码/编码误判。
 */
import { spawn } from 'node:child_process';
import { getWorkspaceRoot } from '../../../../workdir.js';

export interface RunResult {
  code: number | null; // null 表示被超时 kill
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 用当前 Node 可执行文件跑一个脚本（tsc / tsx / node --check / vite / 项目脚本）。
 * @param args 传给 node 的参数（如 ['--import', 'tsx', scriptPath] 或 [tscBin, '--noEmit']）
 * @param opts cwd 默认当前工作区根；timeoutMs 默认 120s
 */
export function runNode(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const cwd = opts.cwd ?? getWorkspaceRoot();
    const timeoutMs = opts.timeoutMs ?? 120000;
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `启动失败: ${e.message}`, timedOut });
    });
  });
}

/** 组合输出：stdout + stderr，去尾部空行 */
export function combinedOutput(r: RunResult): string {
  return [r.stdout, r.stderr].filter((s) => s.length > 0).join('\n').trimEnd();
}

/** 截断长输出 */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

