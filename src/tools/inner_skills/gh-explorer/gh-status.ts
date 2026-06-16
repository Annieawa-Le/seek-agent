import { resolvePath } from '../../../workdir.js';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import { checkGitAvailable, gitRun } from './git-utils';

export const ghStatus = tool({
  description: `查看本地仓库的 git 工作区状态（修改、暂存、未跟踪文件）`,
  inputSchema: z.object({
    repo_path: z.string().describe('本地仓库路径（绝对或相对路径）'),
    short: z.boolean().optional().default(false).describe('是否使用短格式输出，默认详细格式'),
  }),
  execute: async ({ repo_path, short }): Promise<string> => {
    try {
      const git = checkGitAvailable();
      if (!git.ok) return `❌ ${git.error}`;


      const cwd = resolvePath(repo_path);
      const args: string[] = ['status'];
      if (short) args.push('--short');
      args.push('--branch');

      const result = gitRun(args, cwd);

      if (!result.ok) {
        if (result.stderr.includes('not a git repository')) {
          return `"${cwd}" 不是一个 git 仓库。请确认路径正确。`;
        }
        return `git status 失败:\n${result.stderr || result.error}`;
      }

      // 额外获取简洁的统计信息
      const diffStat = gitRun(['diff', '--stat'], cwd);

      const output = [
        `## Git Status — ${path.basename(cwd)}`,
        '',
        '```',
        result.stdout,
        '```',
        '',
      ];

      if (diffStat.ok && diffStat.stdout) {
        output.push('### 变更统计 (diff --stat)');
        output.push('');
        output.push('```');
        output.push(diffStat.stdout);
        output.push('```');
        output.push('');
      }

      output.push(`--- 路径: ${cwd}`);

      return output.join('\n');
    } catch (error) {
      return `gh_status 执行出错: ${(error as Error).message}`;
    }
  },
});


