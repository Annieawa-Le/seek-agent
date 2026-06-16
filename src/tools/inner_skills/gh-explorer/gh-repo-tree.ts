import { tool } from 'ai';
import { z } from 'zod';

const TAVILY_API_BASE = 'https://api.tavily.com';

function getTavilyKey(): string | null {
  return process.env.TAVILY_API_KEY || null;
}

function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN || null;
}

function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace('.git', '') };
}

/**
 * 方式1: 通过 GitHub Git Trees API 获取完整目录树（递归，一次请求，免费）
 */
async function treeViaGitHubApi(
  owner: string, repo: string, branch: string
): Promise<{ tree: { name: string; isDir: boolean; path: string }[] } | null> {
  const token = getGitHubToken();
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'gh-explorer/1.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // 先获取分支引用的 commit SHA
  const refRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    { headers }
  );
  if (!refRes.ok) {
    // 分支不存在，尝试另一个
    return null;
  }
  const refData: any = await refRes.json();
  const commitSha = refData.object?.sha;
  if (!commitSha) return null;

  // 用 ?recursive=1 一次获取整个树
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
    { headers }
  );
  if (!treeRes.ok) {
    if (treeRes.status === 403 || treeRes.status === 429) return null;
    const errText = await treeRes.text().catch(() => '');
    throw new Error(`GitHub API 树请求失败 [${treeRes.status}]: ${errText || treeRes.statusText}`);
  }

  const treeData: any = await treeRes.json();
  const entries = treeData.tree || [];

  const items = entries
    .filter((e: any) => e.type === 'blob' || e.type === 'tree')
    .map((e: any) => ({
      name: e.path.split('/').pop() || e.path,
      isDir: e.type === 'tree',
      path: e.path,
    }));

  return { tree: items };
}

/**
 * 将扁平 tree 数组构建为树形文本
 */
function buildTreeFromFlat(
  items: { name: string; isDir: boolean; path: string }[]
): string[] {
  // 按路径分组
  const children = new Map<string, { name: string; isDir: boolean; path: string }[]>();

  for (const item of items) {
    const parts = item.path.split('/');
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!children.has(parentPath)) children.set(parentPath, []);
    children.get(parentPath)!.push(item);
  }

  // 排序（目录在前，按名称字母序）
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
        const subPrefix = prefix + (isLast ? '    ' : '│   ');
        printDir(entry.path, subPrefix);
      }
    }
  }

  printDir('', '');
  return lines;
}

/**
 * 方式2（回退）: 通过 Tavily crawl 爬取 GitHub 页面解析目录树
 */
async function treeViaTavily(
  repoUrl: string, branch: string | undefined, maxDepth: number
): Promise<string> {
  const apiKey = getTavilyKey();
  if (!apiKey) return 'Fallback 也失败: TAVILY_API_KEY 未设置。';

  const crawlBody: Record<string, unknown> = {
    url: repoUrl,
    max_depth: Math.min(maxDepth, 3),
    max_breadth: 30,
    limit: 100,
    extract_depth: 'basic',
    format: 'markdown',
  };
  if (branch) crawlBody.instructions = `Focus on the ${branch} branch`;

  const res = await fetch(`${TAVILY_API_BASE}/crawl`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(crawlBody),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return `Tavily 爬取失败 [${res.status}]: ${errText || res.statusText}`;
  }

  const data: any = await res.json();
  const pages = data.results || [];
  if (pages.length === 0) return '未获取到仓库页面内容。';

  // 解析文件夹表格
  function parseFolderTable(raw: string): { name: string; isDir: boolean }[] {
    const items: { name: string; isDir: boolean }[] = [];
    const tableMatch = raw.match(/##\s*Folders and files[\s\S]*?(?=##|$)/);
    if (!tableMatch) return items;
    const lines = tableMatch[0].split('\n');
    let inBody = false;
    for (const line of lines) {
      if (line.includes(' --- ') || line.includes('| --- |')) { inBody = true; continue; }
      if (!inBody || !line.trim().startsWith('|')) continue;
      if (line.includes('parent directory') || line.includes('View all files')) continue;
      const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        items.push({
          name: linkMatch[1].replace(/\\_/g, '_'),
          isDir: linkMatch[2].includes('/tree/'),
        });
      }
    }
    return items;
  }

  const dirEntries = new Map<string, { name: string; isDir: boolean }[]>();
  const rootPage = pages.find((p: any) => {
    const u = p.url.replace(/[?#].*$/, '').replace(/\/$/, '');
    return !u.includes('/tree/') && !u.includes('/blob/');
  });
  if (rootPage) {
    const items = parseFolderTable(rootPage.raw_content || '');
    if (items.length > 0) dirEntries.set('/', items);
  }

  // 构建树输出
  const repo = parseRepoUrl(repoUrl);
  if (!repo) return `无法解析仓库 URL: ${repoUrl}`;

  function buildOutput(entries: Map<string, { name: string; isDir: boolean }[]>, prefix = ''): string[] {
    const linesOut: string[] = [];
    const root = entries.get('/') || [];
    for (let i = 0; i < root.length; i++) {
      const e = root[i];
      const isLast = i === root.length - 1;
      const conn = isLast ? '└── ' : '├── ';
      linesOut.push(`${prefix}${conn}${e.name}${e.isDir ? '/' : ''}`);
    }
    return linesOut;
  }

  const detectedBranch = branch || 'main';
  const treeLines = buildOutput(dirEntries, '');
  return [
    `${repoUrl} (branch: ${detectedBranch})`,
    '',
    ...treeLines,
    '',
    `(via Tavily — ${dirEntries.size} 个目录被解析)`,
  ].join('\n');
}

export const ghRepoTree = tool({
  description: `爬取 GitHub 公开仓库的目录/文件树结构，输出类似 tree 命令的层次结构`,
  inputSchema: z.object({
    repo_url: z.string().describe('GitHub 仓库 URL，如 https://github.com/user/repo'),
    branch: z.string().optional().describe('分支名，默认自动检测（master/main）'),
    max_depth: z.number().min(1).max(3).optional().default(3).describe('爬取深度，1-3，默认 3（仅 Tavily 回退时使用；GitHub API 直接返回完整树）'),
  }),
  execute: async ({ repo_url, branch, max_depth }): Promise<string> => {
    try {
      const repo = parseRepoUrl(repo_url);
      if (!repo) return `错误: 无法从 URL 中解析仓库信息: ${repo_url}`;

      const { owner, repo: repoName } = repo;

      // 检测分支：先试传入的 branch，再试 main，再试 master
      const branchesToTry = branch
        ? [branch]
        : ['main', 'master'];

      let treeResult: { tree: { name: string; isDir: boolean; path: string }[] } | null = null;
      let usedBranch = '';

      for (const b of branchesToTry) {
        const result = await treeViaGitHubApi(owner, repoName, b);
        if (result !== null) {
          treeResult = result;
          usedBranch = b;
          break;
        }
      }

      if (treeResult) {
        const treeLines = buildTreeFromFlat(treeResult.tree);
        const dirCount = treeResult.tree.filter(i => i.isDir).length;
        const fileCount = treeResult.tree.filter(i => !i.isDir).length;

        return [
          `${repo_url} (branch: ${usedBranch})`,
          '',
          ...treeLines,
          '',
          `${dirCount} 个目录, ${fileCount} 个文件`,
        ].join('\n');
      }

      // GitHub API 失败，回退到 Tavily
      const fallback = await treeViaTavily(repo_url, branch, max_depth ?? 2);
      return `⚠️ GitHub API 不可用（可能是速率限制），自动回退到 Tavily：\n\n${fallback}`;
    } catch (error) {
      // 出错时回退到 Tavily
      try {
        const apiKey = getTavilyKey();
        if (apiKey) {
          const fallback = await treeViaTavily(repo_url, branch, max_depth ?? 2);
          return `⚠️ GitHub API 出错，自动回退到 Tavily：\n\n${fallback}`;
        }
      } catch {}
      return `gh_repo_tree 执行出错: ${(error as Error).message}`;
    }
  },
});

