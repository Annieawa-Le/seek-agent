import { Command } from '../types';

import path from 'node:path';
import fs from 'node:fs';
import { setCwd, getCwd } from '../../workdir';

export const WorkdirCommand: Command = {
  name: 'workdir',
  description: '切换或查看当前工作目录',
  usage: '/workdir [path]',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t.startsWith('/workdir ') || t.startsWith('workdir ');
  },
  execute(input: string, ctx): void {
    const trimmed = input.trim();
    const match = trimmed.match(/^\/workdir\s+(.+)/i);
    if (match) {
      const newDir = match[1].trim();
      let resolved: string | undefined;
      try {
        resolved = path.resolve(getCwd(), newDir);
        fs.accessSync(resolved, fs.constants.F_OK);
        setCwd(resolved);
        ctx.ui.addUserMessage(`/workdir ${newDir}`);
        ctx.ui.addAgentMessage(`工作目录已切换至: ${resolved}`);
      } catch {
        ctx.ui.addUserMessage(`/workdir ${newDir}`);
        ctx.ui.addAgentMessage(`❌ 目录不存在或不可访问: ${resolved ?? newDir}`);
      }
    } else {
      ctx.ui.addUserMessage('/workdir');
      ctx.ui.addAgentMessage(`当前工作目录: ${getCwd()}`);
    }
  },
};


