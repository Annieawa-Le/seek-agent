import { ToolOutput } from './tool-output';
import type { ExecBulk } from './raw-bulk-types';
import { tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { getCwd } from '../workdir.js';
import { taskRunner } from './task-runner';

/**
 * 智能解码：Windows 下 cmd 命令输出编码不统一——
 * 原生命令（dir/echo/findstr 等）按系统代码页（GBK）输出，Node/Python 程序多为 UTF-8。
 * 先严格 UTF-8 解码（fatal），成功则采用；失败则去掉末尾不完整序列再试
 * （应对中断把输出切在多字节字符中间）；仍失败才回退 GBK。
 */
export function decodeSmart(buf: Buffer): string {
  if (!buf || buf.length === 0) return '';
  const utf8 = (b: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(b);
  try {
    return utf8(buf);
  } catch {
    for (let drop = 1; drop <= Math.min(3, buf.length); drop++) {
      try {
        return utf8(buf.subarray(0, buf.length - drop));
      } catch { /* 末尾截断仍非完整序列，继续尝试 */ }
    }
    return iconv.decode(buf, 'gbk');
  }
}

/**
 * 同步等待上限（毫秒）：execute_command 超过该时长未结束，自动转入后台任务管理。
 * 默认 60 秒；可用环境变量 EXEC_TIMEOUT_MS 覆盖（测试/调试用）。
 */
export function execTimeoutMs(): number {
  const v = Number(process.env.EXEC_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 60_000;
}

/** 生成不会与现有后台任务冲突的任务名（时间戳 + 冲突递增后缀） */
function genDeferredTaskName(): string {
  const base = `exec-${Date.now()}`;
  let name = base;
  for (let i = 2; taskRunner.get(name); i++) name = `${base}-${i}`;
  return name;
}

export const executeCommandTool = tool({
  description: '在终端执行一条系统命令（仅限于工作区目录内），并返回输出。命令默认最多等待 60 秒，超时未结束会自动转入后台任务（与 task_execute 一致的管理），可继续用 task_switch 查看输出、task_kill 终止。',
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    const timeoutMs = execTimeoutMs();
    const cwd = getCwd();
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

    return new Promise<ToolOutput>((resolve) => {
      const child = spawn(command, { shell: true, cwd, env });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const decode = (buf: Buffer) => decodeSmart(buf).trim();

      /** 时限内进程结束：退出码 0 走成功路径，非零/被信号终止走失败路径（与原 exec 抛错语义一致） */
      const finishSync = (code: number | null, signal: string | null) => {
        const stdoutText = decode(Buffer.concat(stdoutChunks));
        const stderrText = decode(Buffer.concat(stderrChunks));
        if (code === 0) {
          let output = stdoutText;
          if (stderrText) output += (output ? '\n[stderr]: ' : '') + stderrText;
          const bulk: ExecBulk = {
            type: 'exec',
            command,
            stdout: stdoutText,
            stderr: stderrText,
            exitCode: 0,
            truncated: output.length > 5000,
          };
          resolve(new ToolOutput(bulk));
        } else {
          let errorOutput = stdoutText;
          if (stderrText) errorOutput += (errorOutput ? '\n[stderr]: ' : '') + stderrText;
          if (!errorOutput) errorOutput = signal ? `命令被信号 ${signal} 终止` : `命令退出码 ${code}`;
          const bulk: ExecBulk = {
            type: 'exec',
            command,
            stdout: stdoutText,
            stderr: stderrText,
            exitCode: code ?? undefined,
            truncated: true,
            error: errorOutput.slice(0, 5000),
          };
          resolve(new ToolOutput(bulk));
        }
      };

      /** 失败路径（spawn 本身失败，如 shell 无法启动）：拼已有输出 + 错误信息 */
      const finishError = (errorText: string) => {
        const stdoutText = decode(Buffer.concat(stdoutChunks));
        const stderrText = decode(Buffer.concat(stderrChunks));
        let errorOutput = stdoutText;
        if (stderrText) errorOutput += (errorOutput ? '\n[stderr]: ' : '') + stderrText;
        if (!errorOutput) errorOutput = errorText || '未知错误';
        const bulk: ExecBulk = {
          type: 'exec',
          command,
          stdout: stdoutText,
          stderr: stderrText,
          truncated: true,
          error: errorOutput.slice(0, 5000),
        };
        resolve(new ToolOutput(bulk));
      };

      /** 超时：进程不中断，直接移交后台任务管理器继续累积输出 */
      const deferToTask = () => {
        if (settled) return;
        settled = true;
        const taskName = genDeferredTaskName();
        const adopted = taskRunner.adopt(taskName, command, child, {
          stdout: decode(Buffer.concat(stdoutChunks)),
          stderr: decode(Buffer.concat(stderrChunks)),
        });
        if (!adopted.ok) {
          finishError(`命令已运行超过 ${Math.round(timeoutMs / 1000)} 秒，转入后台任务失败：${adopted.error}`);
          return;
        }
        const bulk: ExecBulk = {
          type: 'exec',
          command,
          stdout: '',
          stderr: '',
          truncated: false,
          deferred: true,
          taskName,
          timeoutMs,
        };
        resolve(new ToolOutput(bulk));
      };

      const timer = setTimeout(deferToTask, timeoutMs);

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finishSync(code, signal);
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finishError(err.message);
      });
    });
  },
});



