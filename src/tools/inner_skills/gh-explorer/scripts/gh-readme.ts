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
 * 方式1: 通过 raw.githubusercontent.com 直接获取 README.md（免费，零配置）
 */
async function readmeViaRaw(owner: string, repo: string): Promise<{ content: string; branch: string } | null> {
  const branchesToTry = ['main', 'master'];

  for ( const branch of branchesToTry) {
    try {
      // 尝试 README.md
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`
      );
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 10) return { content: text, branch };
      }

      // 尝试 readme.md
      const res2 = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/readme.md`
      );
      if (res2.ok) {
        const text = await res2.text();
        if (text && text.length > 10) return { content: text, branch };
      }

      // 尝试 README.rst
      const res3 = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.rst`
      );
      if (res3.ok) {
        const text = await res3.text();
        if (text && text.length > 10) return { content: text, branch };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 方式2（回退）: 通过 Tavily extract 从仓库页面提取 README
 */
async function readmeViaTavily(repoUrl: string): Promise<string | null> {
  const apiKey = getTavilyKey();
  if (!apiKey) return null;

  // 先用 extract
  const res = await fetch(`${TAVILY_API_BASE}/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: [repoUrl],
      extract_depth: 'advanced',
      format: 'markdown',
    }),
  });

  if (!res.ok) return null;
  const data: any = await res.json();
  const results = data.results || [];
  if (results.length === 0) return null;

  const raw = results[0].raw_content || '';

  // 尝试从页面中提取 README 内容
  function extract(rawContent: string): string {
    // 策略1: 第一个 ## 标题之后到 Folders and files 之间的内容
    const firstH = rawContent.match(/^##\s+(.+)$/m);
    const foldersM = rawContent.match(/##\s*Folders\s+and\s+files/);
    if (firstH && foldersM) {
      const c = rawContent.substring(firstH.index! + firstH[0].length, foldersM.index!).trim();
      if (c.length > 30) return c;
    }

    // 策略2: "Repository files navigation" 前的内容
    const navM = rawContent.match(/Repository\s+files\s+navigation/);
    if (navM) {
      const before = rawContent.substring(0, navM.index!).trim();
      const headings = [...before.matchAll(/^##\s+(.+)$/gm)];
      if (headings.length > 0) {
        const last = headings[headings.length - 1];
        const c = before.substring(last.index! + last[0].length).trim();
        if (c.length > 30) return c;
      }
      if (before.length > 30) return before;
    }

    // 策略3: 第一个 # 标题后的内容
    const titleM = rawContent.match(/^#\s+(.+)$/m);
    if (titleM) {
      const after = rawContent.substring(titleM.index! + titleM[0].length);
      const nextS = after.match(/\n#{1,2}\s/);
      const c = nextS ? after.substring(0, nextS.index).trim() : after.trim();
      if (c.length > 30) return c;
    }

    return '';
  }

  let readme = extract(raw);

  // 如果 extract 不够，尝试 crawl
  if (!readme || readme.length < 30) {
    const crawlRes = await fetch(`${TAVILY_API_BASE}/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: repoUrl,
        max_depth: 1,
        max_breadth: 5,
        limit: 10,
        extract_depth: 'advanced',
        format: 'markdown',
      }),
    });

    if (crawlRes.ok) {
      const crawlData: any = await crawlRes.json();
      const pages = crawlData.results || [];
      if (pages.length > 0) {
        readme = extract(pages[0].raw_content || '');
      }
    }
  }

  if (!readme || readme.length < 20) return null;

  return readme
    .replace(/\[You can't perform that action at this time\.\]/g, '')
    .replace(/Sign in.*?\n/g, '')
    .replace(/You signed in with another tab.*?\n/g, '')
    .replace(/Dismiss alert.*?\n/g, '')
    .trim();
}

export const ghReadme = tool({
  description: `提取 GitHub 仓库的 README 内容`,
  inputSchema: z.object({
    repo_url: z.string().describe('GitHub 仓库 URL，如 https://github.com/user/repo'),
  }),
  execute: async ({ repo_url }): Promise<string> => {
    try {
      const repo = parseRepoUrl(repo_url);
      if (!repo) return `错误: 无法从 URL 中解析仓库信息: ${repo_url}`;

      const { owner, repo: repoName } = repo;

      // 优先走 raw.githubusercontent.com（免费、零消耗）
      const rawResult = await readmeViaRaw(owner, repoName);
      if (rawResult) {
        const { content, branch } = rawResult;
        const lines = content.split('\n');
        const output = [
          `## README — ${owner}/${repoName} (${branch})`,
          `> 来源: https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/README.md`,
          '',
          content,
          '',
          `--- ${lines.length} 行`,
        ].join('\n');
        return output;
      }

      // 回退到 Tavily
      const tavilyReadme = await readmeViaTavily(repo_url);
      if (tavilyReadme) {
        return [
          `## README — ${repo_url}`,
          `> (via Tavily — raw.githubusercontent.com 未返回内容)`,
          '',
          tavilyReadme,
        ].join('\n');
      }

      return `未能提取到 README 内容。仓库 ${repo_url} 可能没有 README 文件，或该仓库为私有。`;
    } catch (error) {
      return `gh_readme 执行出错: ${(error as Error).message}`;
    }
  },
});

