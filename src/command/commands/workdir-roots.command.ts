import { Command } from '../types';
import {
  setCwd,
  getWorkspaceRoot,
  getWorkspaceRoots,
  setWorkspaceRootsOnly,
} from '../../workdir';
import {
  setExplorerRoot,
  getExplorerRoot,
  resetExplorerPath,
} from '../../tools/inner_skills/virtual-explorer/explorer-state';
import { syncMemoryToWorkspace } from '../../tools/memory-core';

/**
 * workdir-roots —— 设置多工作区根列表（主进程 workdir:setRoots / addRoot / removeRoot
 * 静默同步用）。payload 为 JSON：{ roots: string[], active?: string }。
 * 整体替换已挂载根，active 指定当前活跃根（explorer 根与 cwd 跟随活跃根）。
 * 不传参时展示当前状态。
 */
export const WorkdirRootsCommand: Command = {
  name: 'workdir-roots',
  description: '设置多工作区根列表（roots + active，JSON payload）或查看当前状态',
  usage: '/workdir-roots [{"roots":["path1","path2"],"active":"path1"}]',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t.startsWith('/workdir-roots') || t.startsWith('workdir-roots');
  },
  execute(input: string, ctx): void {
    const trimmed = input.trim().replace(/^\/+/, '');
    const match = trimmed.match(/^workdir-roots\s+(.+)/i);

    if (match) {
      const raw = match[1].trim();
      let silent = false;
      let payload = raw;
      if (raw.toLowerCase().startsWith('silent ')) {
        silent = true;
        payload = raw.slice('silent '.length).trim();
      }

      try {
        const parsed = JSON.parse(payload);
        const roots: string[] = Array.isArray(parsed?.roots)
          ? parsed.roots.filter((r: unknown) => typeof r === 'string' && r.length > 0)
          : [];
        if (roots.length === 0) {
          if (!silent) ctx.ui.addUserMessage(`/workdir-roots ${payload}`);
          ctx.ui.addAgentMessage('❌ workdir-roots 需要至少一个根目录');
          return;
        }
        const active = typeof parsed.active === 'string' ? parsed.active : undefined;
        setWorkspaceRootsOnly(roots, active);
        syncMemoryToWorkspace();
        // explorer 根与 cwd 跟随活跃根
        setExplorerRoot(getWorkspaceRoot());
        resetExplorerPath();
        setCwd(getWorkspaceRoot());
        if (!silent) {
          ctx.ui.addUserMessage(`/workdir-roots ${payload}`);
          ctx.ui.addAgentMessage(
            `已设置工作区根列表:\n${getWorkspaceRoots().map(r => `  - ${r}`).join('\n')}\n\n` +
            `当前活跃根: ${getWorkspaceRoot()}`
          );
        }
        ctx.agent.reloadPrompt();
      } catch (err: any) {
        if (!silent) ctx.ui.addUserMessage(`/workdir-roots ${payload}`);
        ctx.ui.addAgentMessage(`❌ payload 无效: ${err.message}`);
      }
    } else {
      // 不传参，展示当前值
      ctx.ui.addUserMessage('/workdir-roots');
      ctx.ui.addAgentMessage(
        `已挂载工作区根:\n${getWorkspaceRoots().map(r => `  - ${r}`).join('\n')}\n\n` +
        `当前活跃根: ${getWorkspaceRoot()}\n\n` +
        `virtual-explorer 根目录: ${getExplorerRoot()}\n\n` +
        `使用 workdir-roots '<json>' 设置列表（JSON: { roots, active }）。`
      );
    }
  },
};

