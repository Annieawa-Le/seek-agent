/**
 * node-check.ts — ts_node_check 工具
 * 对 JS/CJS 文件做语法检查（node --check），用于验证 main.js / preload.cjs 等改动。
 */
import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { getWorkspaceRoot } from '../../../../workdir.js';
import { runNode, truncate } from './run';

export const tsNodeCheck = tool({
  description:
    '对 JS/CJS 文件做语法检查（node --check），不执行代码。' +
    '适合验证 electron/main.js、preload.cjs 等脚本文件改动无语法错误。返回通过/失败及错误详情。',
  inputSchema: z.object({
    file: z.string().describe('相对工作区的文件路径，如 "electron/main.js"'),
  }),
  execute: async ({ file }) => {
    const root = getWorkspaceRoot();
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    if (!fs.existsSync(full)) {
      return `❌ 文件不存在: ${full}`;
    }

    const r = await runNode(['--check', full], {});
    if (r.code === 0) {
      return `✅ node --check 通过: ${file}`;
    }
    const detail = truncate((r.stderr || r.stdout).trim(), 2000);
    return `❌ 语法错误: ${file}\n${detail.text}`;
  },
});

