import { resolvePath } from '../../../workdir.js';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import { checkGitAvailable, gitRun } from './git-utils';

export const ghBranch = tool({
  description: `查看本地仓库的分支列表，或创建/删除分支`,
  inputSchema: z.object({
    repo_path: z.string().describe('本地仓库路径（绝对或相对路径）'),
    action: z.enum(['list', 'create', 'delete']).optional().default('list').describe('操作: list 列出分支, create 创建分支, delete 删除分支'),
    branch_name: z.string().optional().describe('分支名（create/delete 时需要）'),
    all: z.boolean().optional().default(false).describe('是否显示所有分支（包括远程跟踪分支），默认仅本地'),
  }),
  execute: async ({ repo_path, action, branch_name, all }): Promise<string> => {
    try {
      const git = checkGitAvailable();
      if (!git.ok) return `❌ ${git.error}`;


      const cwd = resolvePath(repo_path);
      if (action === 'list') {
        const args: string[] = ['branch'];
        if (all) args.push('-a');
        // 添加 -v 显示最新提交信息
        args.push('-v');

        const result = gitRun(args, cwd);

        if (!result.ok) {
          if (result.stderr.includes('not a git repository')) {
            return `"${cwd}" 不是一个 git 仓库。`;
          }
          return `git branch 失败:\n${result.stderr || result.error}`;
        }

        // 获取当前分支的额外信息
        const currentInfo = gitRun(['branch', '--show-current'], cwd);

        const output = [
          `## Branches — ${path.basename(cwd)}`,
          currentInfo.ok && currentInfo.stdout ? `> 当前分支: ${currentInfo.stdout}` : '',
          '',
          '```',
          result.stdout || '(无分支)',
          '```',
          '',
          `--- ${result.stdout ? result.stdout.split('\n').length : 0} 个分支`,
        ].filter(Boolean).join('\n');

        return output;
      }

      if (action === 'create') {
        if (!branch_name) return '请指定要创建的分支名 (branch_name)。';

        // 先检查是否已存在
        const checkResult = gitRun(['branch', '--list', branch_name], cwd);
        if (checkResult.stdout?.includes(branch_name)) {
          return `分支 "${branch_name}" 已存在。`;
        }

        const result = gitRun(['branch', branch_name], cwd);
        if (!result.ok) return `创建分支失败:\n${result.stderr || result.error}`;

        return `✅ 分支 "${branch_name}" 创建成功。\n使用 gh_checkout 切换到该分支。`;
      }

      if (action === 'delete') {
        if (!branch_name) return '请指定要删除的分支名 (branch_name)。';

        // 不能删除当前分支
        const current = gitRun(['branch', '--show-current'], cwd).stdout;
        if (current === branch_name) {
          return `不能删除当前所在分支 "${branch_name}"，请先切换到其他分支。`;
        }

        const result = gitRun(['branch', '-d', branch_name], cwd);
        if (!result.ok) {
          if (result.stderr.includes('not found')) {
            return `分支 "${branch_name}" 不存在。`;
          }
          if (result.stderr.includes('not fully merged')) {
            return `分支 "${branch_name}" 未合并，强制删除需使用 -D 参数（暂不支持），请先合并后再删除。`;
          }
          return `删除分支失败:\n${result.stderr || result.error}`;
        }

        return `✅ 分支 "${branch_name}" 已删除。`;
      }

      return `未知操作: ${action}`;
    } catch (error) {
      return `gh_branch 执行出错: ${(error as Error).message}`;
    }
  },
});


