import { formatDirectoryContents } from './list-directory.js';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import { getExplorerPath, setExplorerPath, getExplorerRoot } from './explorer-state.js';

export const goUp = tool({
  description: `从当前路径返回上级目录路径。如果已在根目录则返回当前路径。`,
  inputSchema: z.object({
    currentPath: z.string().describe('当前所在的目录路径'),
  }),
  execute: async ({ currentPath }): Promise<string> => {
    try {
      const absPath = path.resolve(currentPath);
      const parentPath = path.dirname(absPath);

      if (parentPath === absPath) {
        return absPath;
      }

      const listing = await formatDirectoryContents(parentPath);
      return `${parentPath}\n\n${listing}`;
    } catch (error) {
      return `❌ go_up 执行出错: ${(error as Error).message}`;
    }
  },
});

/**
 * explorer.go_up — 从 explorer 当前目录返回上级，并更新状态
 * 不会超出 explorer 根目录（explorerRoot）范围
 */
export const explorerGoUp = tool({
  description: '从 virtual-explorer 当前所在目录返回上级目录。如果已在根目录则不动。',
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    const explorerPath = getExplorerPath();
    const explorerRoot = getExplorerRoot();
    const parentPath = path.dirname(explorerPath);

    // 不能超出文件系统根
    if (parentPath === explorerPath) {
      return explorerPath;
    }

    // 不能超出 explorer 根目录
    if (explorerPath === explorerRoot) {
      return explorerPath;
    }

    setExplorerPath(parentPath);
    const listing = await formatDirectoryContents(parentPath);
    return `${parentPath}\n\n${listing}`;
  },
});
