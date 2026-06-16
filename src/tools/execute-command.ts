import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import iconv from 'iconv-lite';
import { getCwd } from '../workdir.js';

const execPromise = promisify(exec);

export const executeCommandTool = tool({
  description: '在终端执行一条系统命令（仅限于工作区目录内），并返回输出。',
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) : Promise<string>=> {
    try {
      // 关键：以 buffer 形式获取原始输出
      const { stdout, stderr } = await execPromise(command, {
        cwd: getCwd(),
        encoding: 'buffer',
        timeout: 30000,
      });

      // 强制使用 GBK 解码
      const decode = (buf: Buffer) => iconv.decode(buf, 'gbk').trim();

      let output = '';
      if (stdout.length > 0) {
        output += decode(stdout);
      }
      if (stderr.length > 0) {
        const errStr = decode(stderr);
        output += (output ? '\n[stderr]: ' : '') + errStr;
      }

      const truncated = output.slice(0, 5000);
      return truncated;
    } catch (error: any) {
      // 从 error 中获取 stderr/stdout Buffer
      const stderrBuf = error.stderr as Buffer;
      const stdoutBuf = error.stdout as Buffer;
      let errorOutput = '';
      if (stdoutBuf?.length) {
        errorOutput += iconv.decode(stdoutBuf, 'gbk');
      }
      if (stderrBuf?.length) {
        errorOutput += (errorOutput ? '\n[stderr]: ' : '') + iconv.decode(stderrBuf, 'gbk');
      }
      // 如果实在没有内容，才使用 error.message（但一般不会）
      if (!errorOutput) {
        errorOutput = error.message || '未知错误';
      }
      return `命令执行失败: ${errorOutput.slice(0, 5000)}`;
    }
  },
});


