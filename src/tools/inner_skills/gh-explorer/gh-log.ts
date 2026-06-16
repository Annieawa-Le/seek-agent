import { resolvePath } from '../../../workdir.js';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import { checkGitAvailable, gitRun } from './git-utils';

export const ghLog = tool({
  description: `查看本地仓库的 git 提交历史（支持限制条数和单文件历史）`,
  inputSchema: z.object({
    repo_path: z.string().describe('本地仓库路径（绝对或相对路径）'),
    max_count: z.number().min(1).max(100).optional().default(20).describe('显示的最大提交数，1-100，默认 20'),
    file: z.string().optional().describe('只显示指定文件的提交历史，如 "src/main.ts"'),
    branch: z.string().optional().describe('指定分支，默认当前分支'),
    graph: z.boolean().optional().default(true).describe('是否显示 ASCII 分支图，默认 true'),
    since: z.string().optional().describe('起始日期，如 "2024-01-01" 或 "2 weeks ago"'),
  }),
  execute: async ({ repo_path, max_count, file, branch, graph, since }): Promise<string> => {
    try {
      const git = checkGitAvailable();
      if (!git.ok) return `❌ ${git.error}`;


      const cwd = resolvePath(repo_path);
      const args: string[] = ['log', `--max-count=${max_count ?? 20}`];
      if (graph) args.push('--graph', '--oneline', '--decorate');
      else args.push('--format=medium');
      if (branch) args.push(branch);
      if (since) args.push(`--since=${since}`);
      if (file) args.push('--', file);

      const result = gitRun(args, cwd);

      if (!result.ok) {
        // 常见错误友好提示
        if (result.stderr.includes('not a git repository')) {
          return `"${cwd}" 不是一个 git 仓库。请确认路径正确，或先用 gh_clone 克隆仓库。`;
        }
        if (result.stderr.includes('bad revision')) {
          return `分支 "${branch}" 不存在。使用 gh_branch 查看可用分支。`;
        }
        return `git log 失败:\n${result.stderr || result.error}`;
      }

      if (!result.stdout) {
        if (file) return `文件 "${file}" 在该仓库中没有提交历史。`;
        return '该仓库没有提交记录。';
      }

      const lines = result.stdout.split('\n');
      const output = [
        `## Commit Log — ${path.basename(cwd)}`,
        file ? `> 文件筛选: ${file}` : '',
        branch ? `> 分支: ${branch}` : '',
        since ? `> 起始: ${since}` : '',
        '',
        '```',
        result.stdout,
        '```',
        '',
        `--- ${lines.length} 行, ${max_count ?? 20} 条 max`,
      ].filter(Boolean).join('\n');

      return output;
    } catch (error) {
      return `gh_log 执行出错: ${(error as Error).message}`;
    }
  },
});


