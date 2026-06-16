import { resolvePath } from '../../../../workdir.js';
import { tool } from 'ai';
import { z } from 'zod';
import { checkGitAvailable, gitRunAsync, repoNameFromUrl } from './git-utils';

export const ghClone = tool({
  description: `将 GitHub 仓库克隆到本地（默认克隆到当前工作目录下的 repos/<repo-name>）`,
  inputSchema: z.object({
    repo_url: z.string().describe('GitHub 仓库 URL，如 https://github.com/user/repo 或 git@github.com:user/repo.git'),
    dest_path: z.string().optional().describe('本地存放路径（相对或绝对），默认为 ./repos/<repo-name>'),
    branch: z.string().optional().describe('指定分支克隆，默认克隆所有分支'),
    shallow: z.boolean().optional().default(false).describe('是否浅克隆（--depth=1），只拉取最新提交，更快更省空间'),
  }),
  execute: async ({ repo_url, dest_path, branch, shallow }): Promise<string> => {
    try {
      const git = checkGitAvailable();
      if (!git.ok) return `❌ ${git.error}`;

      const targetDir = dest_path
        ? resolvePath(dest_path)
        : resolvePath('repos/' + repoNameFromUrl(repo_url));
      const args: string[] = ['clone'];
      if (shallow) args.push('--depth=1');
      if (branch) args.push('--branch', branch);
      args.push(repo_url, targetDir);

      const result = await gitRunAsync(args);

      if (!result.ok) {
        // 如果目录已存在，提示用户
        if (result.stderr.includes('already exists')) {
          return `目录 "${targetDir}" 已存在，已跳过克隆。\n使用 gh_log、gh_status 等工具操作该仓库，或先删除目录后重试。`;
        }
        return `克隆失败:\n${result.stderr || result.error}`;
      }

      const summary = [];
      summary.push(`✅ 克隆成功: ${repo_url}`);
      summary.push(`   本地路径: ${targetDir}`);
      if (branch) summary.push(`   分支: ${branch}`);
      if (shallow) summary.push(`   模式: 浅克隆 (depth=1)`);
      summary.push('');
      summary.push(`可用命令查看仓库:`);
      summary.push(`  gh_log(repo_path="${targetDir}")     — 查看提交历史`);
      summary.push(`  gh_status(repo_path="${targetDir}")  — 查看工作区状态`);
      summary.push(`  gh_branch(repo_path="${targetDir}")  — 查看分支列表`);
      summary.push(`  gh_diff(repo_path="${targetDir}")    — 查看差异`);

      return summary.join('\n');
    } catch (error) {
      return `gh_clone 执行出错: ${(error as Error).message}`;
    }
  },
});



