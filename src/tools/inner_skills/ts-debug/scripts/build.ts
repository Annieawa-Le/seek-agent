/**
 * build.ts — ts_build 工具
 * 构建项目：renderer=渲染层 vite build（默认）、renderer:typecheck=渲染层 tsc、agent=build:agent。
 */
import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { getWorkspaceRoot } from '../../../../workdir.js';
import { runNode, truncate } from './run';

const MAX_OUTPUT = 5000;

export const tsBuild = tool({
  description:
    '构建项目。target 可选：renderer=渲染层 vite build（默认）、renderer:typecheck=渲染层 tsc -b --noEmit、' +
    'agent=node scripts/build-agent.mjs。返回退出码与输出摘要（截断 5000 字符）。',
  inputSchema: z.object({
    target: z
      .enum(['renderer', 'renderer:typecheck', 'agent'])
      .optional()
      .describe('构建目标，默认 renderer（渲染层 vite build）'),
  }),
  execute: async ({ target = 'renderer' }) => {
    const root = getWorkspaceRoot();
    const rendererDir = path.join(root, 'electron/renderer');

    let args: string[];
    let runCwd = root;
    let label: string;
    let timeoutMs = 300000;

    if (target === 'renderer:typecheck') {
      const tscBin = path.join(rendererDir, 'node_modules/typescript/bin/tsc');
      args = [tscBin, '-b', '--noEmit'];
      runCwd = rendererDir;
      label = '渲染层 tsc -b --noEmit';
      timeoutMs = 180000;
    } else if (target === 'agent') {
      args = [path.join(root, 'scripts/build-agent.mjs')];
      label = 'build:agent';
    } else {
      const viteBin = path.join(rendererDir, 'node_modules/vite/bin/vite.js');
      args = [viteBin, 'build'];
      runCwd = rendererDir;
      label = '渲染层 vite build';
    }

    const r = await runNode(args, { cwd: runCwd, timeoutMs });
    const out = truncate((r.stdout + r.stderr).trim(), MAX_OUTPUT);
    const status = r.timedOut
      ? `⏱ 超时被终止`
      : r.code === 0
        ? `✅ 构建成功`
        : `❌ 构建失败（退出码 ${r.code}）`;
    let msg = `${status}: ${label}`;
    if (out.text) msg += `\n${out.text}${out.truncated ? '\n…（输出已截断）' : ''}`;
    return msg;
  },
});

