import { tool } from 'ai';
import { z } from 'zod';

const TAVILY_API_BASE = 'https://api.tavily.com';

function getTavilyKey(): string | null {
  return process.env.TAVILY_API_KEY || null;
}

function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace('.git', '') };
}

/**
 * 方式1: 通过 raw.githubusercontent.com 直接获取文件内容（免费，零消耗）
 */
async function fileViaRaw(
  owner: string, repo: string, filePath: string, branch?: string
): Promise<{ content: string; branch: string } | null> {
  const branchesToTry = branch ? [branch] : ['main', 'master'];

  for (const b of branchesToTry) {
    try {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${filePath}`;
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        if (text) return { content: text, branch: b };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 方式2（回退）: 通过 Tavily extract 从 blob 页面提取
 */
async function fileViaTavily(
  repoUrl: string, filePath: string, branch: string
): Promise<string | null> {
  const apiKey = getTavilyKey();
  if (!apiKey) return null;

  const blobUrl = `${repoUrl}/blob/${branch}/${filePath}`;
  const res = await fetch(`${TAVILY_API_BASE}/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: [blobUrl],
      extract_depth: 'advanced',
      format: 'markdown',
    }),
  });

  if (!res.ok) return null;
  const data: any = await res.json();
  const results = data.results || [];
  if (results.length === 0) return null;

  const raw = results[0].raw_content || '';
  // 清理导航杂音
  const cleanLines = raw.split('\n').filter((line: string) => {
    if (line.includes('Sign in') || line.includes('Sign up')) return false;
    if (line.includes('Navigation Menu') || line.includes('Appearance settings')) return false;
    if (line.includes('You signed in') || line.includes('You switched')) return false;
    if (line.includes('Dismiss alert')) return false;
    if (line.includes('Search code, repositories')) return false;
    if (line.includes('Expand file tree') || line.includes('Copy path')) return false;
    if (line.includes('File metadata') || line.includes('Latest commit')) return false;
    if (line.includes("can't perform that action")) return false;
    if (line.includes('Blame') || line.includes('Raw')) return false;
    return true;
  });

  const cleaned = cleanLines.join('\n').trim();
  return cleaned.length > 10 ? cleaned : null;
}

export const ghFileContent = tool({
  description: `读取 GitHub 仓库中特定文件的内容`,
  inputSchema: z.object({
    repo_url: z.string().describe('GitHub 仓库 URL，如 https://github.com/user/repo'),
    file_path: z.string().describe('文件在仓库中的路径，如 "src/main.ts" 或 "README.md"'),
    branch: z.string().optional().describe('分支名，默认自动检测 (master/main)'),
  }),
  execute: async ({ repo_url, file_path, branch }): Promise<string> => {
    try {
      const repo = parseRepoUrl(repo_url);
      if (!repo) return `错误: 无法从 URL 中解析仓库信息: ${repo_url}`;

      const { owner, repo: repoName } = repo;
      const filePath = file_path.replace(/^\//, '');

      // 优先走 raw.githubusercontent.com（免费）
      const rawResult = await fileViaRaw(owner, repoName, filePath, branch);
      if (rawResult) {
        const { content, branch: usedBranch } = rawResult;
        const lines = content.split('\n');
        const lang = filePath.split('.').pop() || '';

        return [
          `## ${filePath} (${usedBranch})`,
          `> 来源: https://raw.githubusercontent.com/${owner}/${repoName}/${usedBranch}/${filePath}`,
          '',
          '```' + lang,
          content,
          '```',
          '',
          `--- ${lines.length} 行, ${content.length} 字符`,
        ].join('\n');
      }

      // 回退到 Tavily extract
      const fallbackBranch = branch || 'main';
      const tavilyContent = await fileViaTavily(repo_url, filePath, fallbackBranch);
      if (tavilyContent) {
        const lines = tavilyContent.split('\n');
        const lang = filePath.split('.').pop() || '';

        return [
          `## ${filePath} (${fallbackBranch}, via Tavily)`,
          `> 来源: ${repo_url}/blob/${fallbackBranch}/${filePath}`,
          '',
          '```' + lang,
          tavilyContent,
          '```',
          '',
          `--- ${lines.length} 行`,
        ].join('\n');
      }

      return `未找到文件: ${filePath}。请确认文件路径和仓库地址正确。`;
    } catch (error) {
      return `gh_file_content 执行出错: ${(error as Error).message}`;
    }
  },
});

