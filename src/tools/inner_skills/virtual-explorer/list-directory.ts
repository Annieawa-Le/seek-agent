import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { getExplorerPath } from './explorer-state.js';

export const listDirectory = tool({
  description: `获取指定路径下的目录结构，仅展示当前层级的文件和文件夹（不递归子目录）。返回文件和文件夹的列表，带类型标识。`,
  inputSchema: z.object({
    path: z.string().describe('要列出内容的目录路径（绝对路径或相对当前工作目录的路径）'),
  }),
  execute: async ({ path: targetPath }): Promise<string> => {
    try {
      const absPath = path.resolve(targetPath);

      const entries = await fs.readdir(absPath, { withFileTypes: true });

      if (entries.length === 0) {
        return `目录为空: ${absPath}`;
      }

      // 分离文件和文件夹，文件夹排在前面
      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => `📁 ${e.name}/`);
      const files = entries
        .filter(e => e.isFile())
        .map(e => `📄 ${e.name}`);

      const lines = [
        `📂 ${absPath}`,
        '',
        ...dirs,
        ...files,
      ];

      return lines.join('\n');
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('ENOENT')) {
        return `❌ 目录不存在: ${targetPath}`;
      }
      if (msg.includes('ENOTDIR')) {
        return `❌ 路径不是目录: ${targetPath}`;
      }
      if (msg.includes('EACCES')) {
        return `❌ 无权限访问: ${targetPath}`;
      }
      return `❌ list_directory 执行出错: ${msg}`;
    }
  },
});

/**
 * explorer.list_directory — 列出 explorer 当前目录的内容
 */
export const explorerListDirectory = tool({
  description: '列出 virtual-explorer 当前所在目录的文件和文件夹（不递归子目录）。',
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    const explorerPath = getExplorerPath();
    try {
      const entries = await fs.readdir(explorerPath, { withFileTypes: true });
      if (entries.length === 0) return `目录为空: ${explorerPath}`;

      const dirs = entries.filter(e => e.isDirectory()).map(e => `📁 ${e.name}/`);
      const files = entries.filter(e => e.isFile()).map(e => `📄 ${e.name}`);

      return [`📂 ${explorerPath}`, '', ...dirs, ...files].join('\n');
    } catch (error) {
      return `❌ list_directory 执行出错: ${(error as Error).message}`;
    }
  },
});
