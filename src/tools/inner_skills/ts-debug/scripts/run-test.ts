/**
 * run-test.ts — ts_run_test 工具
 * 用 node --import tsx 直跑 scripts/ 下的测试脚本（UTF-8 输出，无 cmd 管道乱码）。
 */
import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { getWorkspaceRoot } from '../../../../workdir.js';
import { runNode, truncate } from './run';

const MAX_OUTPUT = 6000;

export const tsRunTest = tool({
  description:
    '运行 scripts/ 下的 tsx 测试脚本（node --import tsx 直跑，UTF-8 输出无损）。' +
    'script 自动补全 scripts/ 前缀与 .ts 后缀，如 "test-context-compactor" → scripts/test-context-compactor.ts。' +
    '返回退出码与输出（截断 6000 字符）。退出码 0 即测试通过。',
  inputSchema: z.object({
    script: z.string().describe('脚本名，如 "test-context-compactor" 或 "scripts/test-slim-round.ts"'),
    args: z.array(z.string()).optional().describe('传给脚本的额外参数'),
  }),
  execute: async ({ script, args }) => {
    const root = getWorkspaceRoot();
    let scriptPath = script;
    if (!path.isAbsolute(scriptPath)) {
      if (!scriptPath.startsWith('scripts/') && !scriptPath.startsWith('scripts\\')) {
        scriptPath = path.join('scripts', scriptPath);
      }
      if (!scriptPath.endsWith('.ts')) scriptPath += '.ts';
      scriptPath = path.join(root, scriptPath);
    }
    if (!fs.existsSync(scriptPath)) {
      return `❌ 脚本不存在: ${scriptPath}\n提示：默认放在工作区 scripts/ 目录下，可传完整相对路径。`;
    }

    const r = await runNode(['--import', 'tsx', scriptPath, ...(args ?? [])], { timeoutMs: 300000 });
    const out = truncate(r.stdout, MAX_OUTPUT);
    const err = truncate(r.stderr, 3000);

    let msg = r.timedOut
      ? `⏱ 超时（300s）被终止: ${script}`
      : r.code === 0
        ? `✅ 测试通过（退出码 0）: ${script}`
        : `❌ 测试失败（退出码 ${r.code}）: ${script}`;
    if (out.text.trim()) msg += `\n[输出]\n${out.text.trim()}${out.truncated ? '\n…（输出已截断）' : ''}`;
    if (err.text.trim()) msg += `\n[stderr]\n${err.text.trim()}${err.truncated ? '\n…（stderr 已截断）' : ''}`;
    return msg;
  },
});

