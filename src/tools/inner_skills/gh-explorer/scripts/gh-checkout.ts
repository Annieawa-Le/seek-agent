import { resolvePath } from '../../../../workdir.js';
import { tool } from 'ai';
import { z } from 'zod';
import { checkGitAvailable, gitRun } from './git-utils';

export const ghCheckout = tool({
  description: `切换分支或恢复工作区文件`,
  inputSchema: z.object({
    repo_path: z.string().describe('本地仓库路径（绝对或相对路径）'),
    target: z.string().describe('要切换到的分支名、提交 hash 或要恢复的文件路径'),
    create_new: z.boolean().optional().default(false).describe('创建并切换到一个新分支（相当于 git checkout -b）'),
  }),
  execute: async ({ repo_path, target, create_new }): Promise<string> => {
    try {
      const git = checkGitAvailable();
      if (!git.ok) return `❌ ${git.error}`;


      const cwd = resolvePath(repo_path);
      const args: string[] = ['checkout'];
      if (create_new) args.push('-b');
      args.push(target);

      const result = gitRun(args, cwd);

      if (!result.ok) {
        if (result.stderr.includes('not a git repository')) {
          return `"${cwd}" 不是一个 git 仓库。`;
        }
        if (result.stderr.includes('already exists')) {
          return `分支 "${target}" 已存在。使用 gh_checkout ${target} 直接切换。`;
        }
        if (result.stderr.includes('did not match any file')) {
          return `目标 "${target}" 不存在（既不是分支名也不是提交 hash）。`;
        }
        if (result.stderr.includes('local changes')) {
          return `有未提交的本地修改，请先提交或使用 gh_status 查看。\n${result.stderr}`;
        }
        return `git checkout 失败:\n${result.stderr || result.error}`;
      }

      // 获取切换后的当前分支信息
      const current = gitRun(['branch', '--show-current'], cwd);

      const output = [
        `✅ ${result.stdout || `已切换到 "${target}"`}`,
        current.ok && current.stdout ? `当前分支: ${current.stdout}` : '',
      ].filter(Boolean).join('\n');

      return output;
    } catch (error) {
      return `gh_checkout 执行出错: ${(error as Error).message}`;
    }
  },
});



