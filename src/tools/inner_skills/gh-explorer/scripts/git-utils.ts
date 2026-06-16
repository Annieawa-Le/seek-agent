import { spawnSync, spawn } from 'child_process';

/** 检查 git 是否可用 */
export function checkGitAvailable(): { ok: boolean; version?: string; error?: string } {
  try {
    const result = spawnSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    if (result.status === 0) {
      return { ok: true, version: (result.stdout || '').trim() };
    }
    return { ok: false, error: 'git 未安装或不可用，请先安装 Git: https://git-scm.com' };
  } catch {
    return { ok: false, error: 'git 未安装或不可用，请先安装 Git: https://git-scm.com' };
  }
}

/** 执行 git 命令（同步，适合短命令）
 *  使用 spawnSync 避免 shell 分词导致的路径空格问题 */
export function gitRun(
  args: string[],
  cwd?: string
): { ok: boolean; stdout: string; stderr: string; error?: string } {
  try {
    const result = spawnSync('git', args, {
      encoding: 'utf-8',
      cwd,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      error: result.error?.message,
    };
  } catch (e: any) {
    return { ok: false, stdout: '', stderr: '', error: e.message };
  }
}

/** 执行 git 命令（异步，适合长时间操作如 clone）
 *  使用 spawn 避免 shell 分词导致的路径空格问题 */
export async function gitRunAsync(
  args: string[],
  cwd?: string
) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>((resolve) => {
    const child = spawn('git', args, {
      cwd,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer | string) => { stdout += String(data); });
    child.stderr?.on('data', (data: Buffer | string) => { stderr += String(data); });
    child.on('close', (code: number | null) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on('error', (err: Error) => {
      resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), error: err.message });
    });
  });
}

/** 从 URL 提取 owner/repo 作为默认目录名 */
export function repoNameFromUrl(url: string): string {
  const match = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (match) return match[2].replace('.git', '');
  // 也支持 git@github.com:user/repo.git 格式
  const match2 = url.match(/github\.com[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match2) return match2[2].replace('.git', '');
  return 'repo';
}

/** 安全路径拼接，防止路径穿越 */
export function safeResolve(base: string, relative: string): string {
  const resolved = require('path').resolve(base, relative);
  if (!resolved.startsWith(require('path').resolve(base))) {
    throw new Error('路径穿越被拒绝');
  }
  return resolved;
}




