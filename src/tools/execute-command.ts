import { ToolOutput } from './tool-output';
import type { ExecBulk } from './raw-bulk-types';
import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import iconv from 'iconv-lite';
import { getCwd } from '../workdir.js';

/**
 * 智能解码：Windows 下 cmd 命令输出编码不统一——
 * 原生命令（dir/echo/findstr 等）按系统代码页（GBK）输出，Node/Python 程序多为 UTF-8。
 * 先严格 UTF-8 解码（fatal），成功则采用；失败则去掉末尾不完整序列再试
 * （应对 timeout/中断把输出切在多字节字符中间的情况）；仍失败才回退 GBK。
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


const execPromise = promisify(exec);

export const executeCommandTool = tool({
  description: '在终端执行一条系统命令（仅限于工作区目录内），并返回输出。',
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    try {
      // 关键：以 buffer 形式获取原始输出
      const { stdout, stderr } = await execPromise(command, {
        cwd: getCwd(),
        encoding: 'buffer',
        timeout: 30000,
        // 让 Python 子进程也输出 UTF-8，配合智能解码减少编码误判
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });

      // 智能解码：UTF-8 优先，失败回退 GBK
      const decode = (buf: Buffer) => decodeSmart(buf).trim();

      let output = '';
      if (stdout.length > 0) {
        output += decode(stdout);
      }
      if (stderr.length > 0) {
        const errStr = decode(stderr);
        output += (output ? '\n[stderr]: ' : '') + errStr;
      }

      const truncated = output.slice(0, 5000);
      const execBulk: ExecBulk = {
        type: 'exec',
        command,
        stdout: decode(stdout),
        stderr: decode(stderr),
        truncated: output.length > 5000,
      };
      return new ToolOutput(execBulk, truncated);
    } catch (error: any) {
      // 从 error 中获取 stderr/stdout Buffer
      const stderrBuf = error.stderr as Buffer;
      const stdoutBuf = error.stdout as Buffer;
      let errorOutput = '';
      if (stdoutBuf?.length) {
        errorOutput += decodeSmart(stdoutBuf);
      }
      if (stderrBuf?.length) {
        errorOutput += (errorOutput ? '\n[stderr]: ' : '') + decodeSmart(stderrBuf);
      }
      // 如果实在没有内容，才使用 error.message（但一般不会）
      if (!errorOutput) {
        errorOutput = error.message || '未知错误';
      }
      const errorText = errorOutput.slice(0, 5000);
      const execBulk: ExecBulk = {
        type: 'exec',
        command,
        stdout: stdoutBuf?.length ? decodeSmart(stdoutBuf) : '',
        stderr: stderrBuf?.length ? decodeSmart(stderrBuf) : '',
        truncated: true,
        error: errorText,
      };
      return new ToolOutput(execBulk, `命令执行失败: ${errorText}`);
    }
  },
});







