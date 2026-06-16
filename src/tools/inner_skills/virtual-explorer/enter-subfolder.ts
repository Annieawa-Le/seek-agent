import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { getExplorerPath, setExplorerPath } from './explorer-state.js';
import { formatDirectoryContents } from './list-directory.js';

export const enterSubfolder = tool({
  description: `进入指定路径下的某个子文件夹，返回该子文件夹的规范路径。`,
  inputSchema: z.object({
    parentPath: z.string().describe('当前所在的目录路径'),
    folderName: z.string().describe('要进入的子文件夹名称'),
  }),
  execute: async ({ parentPath, folderName }): Promise<string> => {
    try {
      const parentResolved = path.resolve(parentPath);
      const childPath = path.join(parentResolved, folderName);

      const stat = await fs.stat(childPath);
      if (!stat.isDirectory()) {
        return `❌ "${folderName}" 不是目录，无法进入。`;
      }

      const listing = await formatDirectoryContents(childPath);
      return `${childPath}\n\n${listing}`;
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('ENOENT')) {
        return `❌ 子文件夹不存在: "${folderName}" (在 ${parentPath} 下)`;
      }
      if (msg.includes('EACCES')) {
        return `❌ 无权限访问: ${parentPath}/${folderName}`;
      }
      return `❌ enter_subfolder 执行出错: ${msg}`;
    }
  },
});

/**
 * explorer.enter_subfolder — 从 explorer 当前目录进入子文件夹，并更新状态
 */
export const explorerEnterSubfolder = tool({
  description: '从 virtual-explorer 当前所在目录进入某个子文件夹（更新 explorer 的当前位置）。',
  inputSchema: z.object({
    folderName: z.string().describe('要进入的子文件夹名称'),
  }),
  execute: async ({ folderName }): Promise<string> => {
    const explorerPath = getExplorerPath();
    try {
      const childPath = path.join(explorerPath, folderName);
      const stat = await fs.stat(childPath);
      if (!stat.isDirectory()) {
        return `❌ "${folderName}" 不是目录，无法进入。`;
      }
      setExplorerPath(childPath);
      const listing = await formatDirectoryContents(childPath);
      return `${childPath}\n\n${listing}`;
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('ENOENT')) {
        return `❌ 子文件夹不存在: "${folderName}" (在 ${explorerPath} 下)`;
      }
      return `❌ enter_subfolder 执行出错: ${msg}`;
    }
  },
});
