import { Command } from '../types';
import path from 'node:path';
import fs from 'node:fs';
import { setCwd, getWorkspaceRoot, setWorkspaceRootOnly, resetWorkspaceRoot } from '../../workdir';
import { syncMemoryToWorkspace } from '../../tools/memory-core';
import {
  setExplorerRoot,
  getExplorerRoot,
  resetExplorerPath,
  resetExplorerRoot,
} from '../../tools/inner_skills/virtual-explorer/explorer-state';

export const WorkdirGlobalCommand: Command = {
  name: 'workdir-global',
  description: '切换或查看 virtual-explorer 的根目录位置',
  usage: '/workdir-global [path]  — 不传参则查看当前值',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t.startsWith('/workdir-global') || t.startsWith('workdir-global');
  },
  execute(input: string, ctx): void {
    const trimmed = input.trim().replace(/^\/+/, '');
    const match = trimmed.match(/^workdir-global\s+(.+)/i);

    if (match) {
      const raw = match[1].trim();
      // 静默模式：workdir-global silent <path> —— 主进程切换工作区/新建会话同步时使用，不产生气泡
      let silent = false;
      let pathArg = raw;
      if (raw.toLowerCase().startsWith('silent ')) {
        silent = true;
        pathArg = raw.slice('silent '.length).trim();
      }


      // 特殊值：reset
      if (pathArg.toLowerCase() === 'reset') {
        resetExplorerRoot();
        resetExplorerPath();
        resetWorkspaceRoot();
        syncMemoryToWorkspace();
        setCwd(getWorkspaceRoot());
        if (!silent) {
          ctx.ui.addUserMessage(`/workdir-global reset`);
          ctx.ui.addAgentMessage(
            `virtual-explorer 根目录和工作目录已重置为工作区根目录:\n${getExplorerRoot()}`
          );
        }
        ctx.agent.reloadPrompt();
        return;
      }

      // 正常路径切换
      try {
        // 绝对路径直接用，相对路径基于当前 explorerRoot 解析
        const resolved = path.isAbsolute(pathArg)
          ? path.normalize(pathArg)
          : path.resolve(getExplorerRoot(), pathArg);

        // 确保目标目录存在
        try {
          fs.accessSync(resolved, fs.constants.F_OK);
        } catch {
          if (!silent) ctx.ui.addUserMessage(`/workdir-global ${pathArg}`);
          ctx.ui.addAgentMessage(`❌ 目录不存在: ${resolved}`);
          return;
        }

        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          if (!silent) ctx.ui.addUserMessage(`/workdir-global ${pathArg}`);
          ctx.ui.addAgentMessage(`❌ 路径不是目录: ${resolved}`);
          return;
        }
        setExplorerRoot(resolved);
        resetExplorerPath();
        setCwd(resolved);
        setWorkspaceRootOnly(resolved);
        syncMemoryToWorkspace();
        if (!silent) {
          ctx.ui.addUserMessage(`/workdir-global ${pathArg}`);
          ctx.ui.addAgentMessage(
            `virtual-explorer 根目录和工作目录已切换至:\n${resolved}\n\n` +
            `提示：当前 explorer 位置已重置到新根目录。`
          );
        }
        ctx.agent.reloadPrompt();
      } catch (err: any) {
        if (!silent) ctx.ui.addUserMessage(`/workdir-global ${pathArg}`);
        ctx.ui.addAgentMessage(`❌ 路径无效: ${err.message}`);
      }
    } else {
      // 不传参，展示当前值
      ctx.ui.addUserMessage('/workdir-global');
      ctx.ui.addAgentMessage(
        `当前 virtual-explorer 根目录:\n${getExplorerRoot()}\n\n` +
        `使用 /workdir-global <path> 切换，/workdir-global reset 重置到工作区根目录。`
      );
    }
  },
};





