import { tool } from 'ai';
import { z } from 'zod';

const TAVILY_API_BASE = 'https://api.tavily.com';

function getTavilyKey(): string | null {
  return process.env.TAVILY_API_KEY || null;
}

function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN || null;
}

/**
 * 方式1: 通过 GitHub REST API 搜索仓库（返回结构化数据，免费）
 */
async function searchViaGitHubApi(query: string, maxResults: number): Promise<string | null> {
  const token = getGitHubToken();
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'gh-explorer/1.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(maxResults, 100)}&sort=stars&order=desc`,
    { headers }
  );

  if (!res.ok) {
    // 403 = 速率限制，放弃走 Tavily
    if (res.status === 403 || res.status === 429) return null;
    const errText = await res.text().catch(() => '');
    return `GitHub API 搜索失败 [${res.status}]: ${errText || res.statusText}`;
  }

  const data: any = await res.json();
  const repos = data.items || [];
  if (repos.length === 0) return `未找到与 "${query}" 相关的仓库。`;

  const lines: string[] = [];
  lines.push(`## 搜索结果: "${query}"`);
  lines.push(`共 ${data.total_count} 个结果，显示前 ${repos.length} 个\n`);

  for (let i = 0; i < repos.length; i++) {
    const r = repos[i];
    const lang = r.language ? ` ${r.language}` : '';
    const stars = r.stargazers_count ? `⭐ ${r.stargazers_count}` : '';
    const forks = r.forks_count ? ` 🍴 ${r.forks_count}` : '';
    const desc = r.description ? r.description.substring(0, 200) : '(无描述)';

    lines.push(`${i + 1}. **${r.full_name}**${stars}${forks}${lang}`);
    lines.push(`   ${desc}`);
    lines.push(`   ${r.html_url}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 方式2（回退）: 通过 Tavily 搜索
 */
async function searchViaTavily(query: string, maxResults: number): Promise<string> {
  const apiKey = getTavilyKey();
  if (!apiKey) return 'Fallback 也失败: TAVILY_API_KEY 未设置。请设置 GITHUB_TOKEN 以使用 GitHub API。';

  const res = await fetch(`${TAVILY_API_BASE}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_domains: ['github.com'],
      include_answer: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return `搜索请求失败 [${res.status}]: ${errText || res.statusText}`;
  }

  const data: any = await res.json();
  const results = data.results || [];
  if (results.length === 0) return `未找到与 "${query}" 相关的 GitHub 仓库。`;

  const lines: string[] = [];
  lines.push(`## 搜索结果: "${query}" (via Tavily)`);
  lines.push(`共找到 ${results.length} 个结果\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **${r.title || '无标题'}**`);
    lines.push(`   URL: ${r.url || '无'}`);
    if (r.content) {
      const desc = r.content.replace(/<[^>]*>/g, '').substring(0, 200);
      lines.push(`   简介: ${desc}${desc.length >= 200 ? '...' : ''}`);
    }
    lines.push('');
  }

  if (data.answer) lines.push(`---\n**AI 摘要**: ${data.answer}`);
  return lines.join('\n');
}

export const ghSearchRepos = tool({
  description: `搜索 GitHub 上的公开仓库，返回仓库列表（含描述、星标数、语言等信息）`,
  inputSchema: z.object({
    query: z.string().describe('搜索关键词，如 "rust web framework" 或 "tavily python"'),
    max_results: z.number().min(1).max(20).optional().default(10).describe('返回结果数，1-20，默认 10'),
  }),
  execute: async ({ query, max_results }): Promise<string> => {
    try {
      // 优先走 GitHub API（免费、结构化）
      const result = await searchViaGitHubApi(query, max_results ?? 10);
      if (result !== null) return result;

      // API 受限时回退到 Tavily
      const fallback = await searchViaTavily(query, max_results ?? 10);
      return `⚠️ GitHub API 速率受限，自动回退到 Tavily 搜索：\n\n${fallback}`;
    } catch (error) {
      return `gh_search_repos 执行出错: ${(error as Error).message}`;
    }
  },
});

