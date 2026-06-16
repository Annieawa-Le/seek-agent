import { tool } from 'ai';
import { z } from 'zod';

function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace('.git', '') };
}

function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN || null;
}

/**
 * 获取 README（通过 raw.githubusercontent.com，免费）
 */
async function fetchReadme(owner: string, repo: string): Promise<{ content: string; branch: string } | null> {
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`
      );
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 10) return { content: text, branch };
      }
    } catch { continue; }
  }
  return null;
}

/**
 * 获取目录树（通过 GitHub Git Trees API，免费）
 */
async function fetchTree(
  owner: string, repo: string
): Promise<{
  items: { name: string; isDir: boolean; path: string }[];
  branch: string;
} | null> {
  const token = getGitHubToken();
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'gh-explorer/1.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  for (const branch of ['main', 'master']) {
    try {
      // 获取分支引用的 commit SHA
      const refRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        { headers }
      );
      if (!refRes.ok) continue;

      const refData: any = await refRes.json();
      const commitSha = refData.object?.sha;
      if (!commitSha) continue;

      // 递归获取整个树
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
        { headers }
      );
      if (!treeRes.ok) continue;

      const treeData: any = await treeRes.json();
      const entries = treeData.tree || [];

      const items = entries
        .filter((e: any) => e.type === 'blob' || e.type === 'tree')
        .map((e: any) => ({
          name: e.path.split('/').pop() || e.path,
          isDir: e.type === 'tree',
          path: e.path,
        }));

      return { items, branch };
    } catch { continue; }
  }

  return null;
}

/**
 * 构建树形文本
 */
function buildTreeText(
  items: { name: string; isDir: boolean; path: string }[]
): string[] {
  const children = new Map<string, { name: string; isDir: boolean; path: string }[]>();
  for (const item of items) {
    const parts = item.path.split('/');
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!children.has(parentPath)) children.set(parentPath, []);
    children.get(parentPath)!.push(item);
  }

  for (const [, list] of children) {
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  const lines: string[] = [];
  function printDir(dirPath: string, prefix: string) {
    const entries = children.get(dirPath) || [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const suffix = entry.isDir ? '/' : '';
      lines.push(`${prefix}${connector}${entry.name}${suffix}`);
      if (entry.isDir) {
        printDir(entry.path, prefix + (isLast ? '    ' : '│   '));
      }
    }
  }

  printDir('', '');
  return lines;
}

export const ghExplore = tool({
  description: `一站式探索 GitHub 仓库：获取目录树和 README，输出完整项目概览`,
  inputSchema: z.object({
    repo_url: z.string().describe('GitHub 仓库 URL（如 https://github.com/user/repo）'),
  }),
  execute: async ({ repo_url }): Promise<string> => {
    try {
      const repo = parseRepoUrl(repo_url);
      if (!repo) return `错误: 无法从 URL 中解析仓库信息: ${repo_url}`;

      const { owner, repo: repoName } = repo;
      const output: string[] = [];
      output.push(`# 📦 ${owner}/${repoName}`);
      output.push(`> ${repo_url}`);
      output.push('');

      // 并行获取 README 和目录树（都不走 Tavily，免费）
      const [readmeResult, treeResult] = await Promise.all([
        fetchReadme(owner, repoName),
        fetchTree(owner, repoName),
      ]);

      // README
      if (readmeResult) {
        const { content, branch } = readmeResult;
        const readmeLines = content.split('\n');
        // 截取前 60 行避免过长
        const truncated = readmeLines.length > 60
          ? readmeLines.slice(0, 60).join('\n') + '\n\n_... (README 已截断，使用 gh_readme 查看完整内容)_'
          : content;

        output.push('## 📖 README');
        output.push(`> branch: ${branch}`);
        output.push('');
        output.push(truncated);
        output.push('');
      } else {
        output.push('## 📖 README');
        output.push('');
        output.push('(未找到 README 文件)');
        output.push('');
      }

      // 目录树
      if (treeResult) {
        const { items, branch } = treeResult;
        const treeLines = buildTreeText(items);
        const dirCount = items.filter(i => i.isDir).length;
        const fileCount = items.filter(i => !i.isDir).length;

        output.push('## 📁 目录结构');
        output.push(`> branch: ${branch}`);
        output.push('');
        output.push(`${repo_url}`);
        output.push('');
        output.push(...treeLines);
        output.push('');
        output.push(`**概览**: ${dirCount} 个目录, ${fileCount} 个文件`);
      } else {
        output.push('## 📁 目录结构');
        output.push('');
        output.push('(GitHub API 不可用，可能是速率限制。设置 GITHUB_TOKEN 可提高限制。)');
        output.push('');
      }

      output.push('---');
      output.push('> 全部通过免费 API 获取，未消耗 Tavily credits');
      output.push('> 使用 gh_repo_tree 查看完整目录树 | 使用 gh_readme 查看完整 README | 使用 gh_file_content 查看具体文件');

      return output.join('\n');
    } catch (error) {
      return `gh_explore 执行出错: ${(error as Error).message}`;
    }
  },
});

