import { resolvePath } from '../../../workdir.js';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import { checkGitAvailable, gitRun } from './git-utils';

export const ghDiff = tool({
  description: `查看本地仓库的差异（工作区 vs 暂存区、暂存区 vs 最近提交、或任意两个提交间差异）`,
  inputSchema: z.object({
    repo_path: z.string().describe('本地仓库路径（绝对或相对路径）'),
    type: z.enum(['working', 'staged', 'commits']).optional().default('working').describe('差异类型: working=工作区未暂存, staged=已暂存待提交, commits=两提交间'),
    commit1: z.string().optional().describe('起始提交（commits 类型时需要），如 HEAD~3、分支名或 commit hash'),
    commit2: z.string().optional().describe('结束提交（commits 类型时可省略，默认 HEAD）'),
    file: z.string().optional().describe('只查看特定文件的差异'),
    stat_only: z.boolean().optional().default(false).describe('仅显示统计摘要而非完整 diff，默认 false'),
  }),
  execute: async ({ repo_path, type, commit1, commit2, file, stat_only }): Promise<string> => {
    try {
      const git = checkGitAvailable();
      if (!git.ok) return `❌ ${git.error}`;


      const cwd = resolvePath(repo_path);
      let args: string[] = ['diff'];

      if (stat_only) args.push('--stat');

      if (type === 'staged') {
        args.push('--cached');
      } else if (type === 'commits') {
        if (!commit1) return 'commits 模式需要指定 commit1（起始提交）。';
        const range = commit2 ? `${commit1}..${commit2}` : `${commit1}`;
        args.push(range);
      }
      // working 模式不加额外参数，默认就是工作区 vs 暂存区

      if (file) args.push('--', file);

      const result = gitRun(args, cwd);

      if (!result.ok) {
        if (result.stderr.includes('not a git repository')) {
          return `"${cwd}" 不是一个 git 仓库。`;
        }
        if (result.stderr.includes('bad revision')) {
          return `提交引用无效: ${commit1}${commit2 ? `..${commit2}` : ''}。请检查提交 hash 或分支名。`;
        }
        return `git diff 失败:\n${result.stderr || result.error}`;
      }

      if (!result.stdout) {
        const msgs: Record<string, string> = {
          'working': '工作区干净，没有未暂存的变更。',
          'staged': '暂存区干净，没有已暂存待提交的变更。',
          'commits': '两个提交之间没有差异。',
        };
        return `${msgs[type] || '没有差异。'}`;
      }

      const lines = result.stdout.split('\n');
      const lang = stat_only ? '' : 'diff';

      const typeLabels: Record<string, string> = {
        'working': '工作区未暂存',
        'staged': '暂存区',
        'commits': `${commit1}${commit2 ? ` → ${commit2}` : ''}`,
      };

      const output = [
        `## Git Diff — ${path.basename(cwd)}`,
        `> ${typeLabels[type] || type}`,
        file ? `> 文件: ${file}` : '',
        '',
        '```' + lang,
        result.stdout,
        '```',
        '',
        `--- ${lines.length} 行`,
      ].filter(Boolean).join('\n');

      return output;
    } catch (error) {
      return `gh_diff 执行出错: ${(error as Error).message}`;
    }
  },
});


