import { tool } from 'ai';
import { z } from 'zod';
import { loadMappingDataAsync, parseIcons } from './data';

export const searchIcons = tool({
  description: `通过关键词搜索 Codicons 图标名称（大小写不敏感），返回匹配的图标名、codepoint、别名列表。支持模糊搜索。`,
  inputSchema: z.object({
    keyword: z.string().describe('搜索关键词，如 "arrow", "debug", "file", "git", "settings"'),
    max_results: z.number().default(20).describe('最大返回条数，默认 20'),
  }),
  execute: async ({ keyword, max_results }): Promise<string> => {
    const kw = keyword.toLowerCase().trim();
    if (!kw) return '请输入搜索关键词。';

    const mapping = await loadMappingDataAsync();
    const icons = parseIcons(mapping);

    const results: Array<{ name: string; codepoint: number; aliases: string[]; matchField: string }> = [];

    for (const icon of icons) {
      // Match on codepoint
      if (String(icon.codepoint) === kw) {
        results.push({ name: icon.primaryName, codepoint: icon.codepoint, aliases: icon.aliases, matchField: 'codepoint' });
        continue;
      }
      // Match on primary name
      if (icon.primaryName.includes(kw)) {
        results.push({ name: icon.primaryName, codepoint: icon.codepoint, aliases: icon.aliases, matchField: 'name' });
        continue;
      }
      // Match on alias
      for (const alias of icon.aliases) {
        if (alias.includes(kw)) {
          results.push({ name: icon.primaryName, codepoint: icon.codepoint, aliases: icon.aliases, matchField: 'alias' });
          break;
        }
      }
    }

    if (results.length === 0) {
      return `未找到与 "${keyword}" 匹配的图标。试试其他关键词如：add, file, folder, debug, git, symbol, settings, close, search, check, arrow, layout, terminal, copilot, star, play。`;
    }

    const sortOrder: Record<string, number> = { name: 0, alias: 1, codepoint: 2 };
    results.sort((a, b) => sortOrder[a.matchField] - sortOrder[b.matchField]);

    const limited = results.slice(0, max_results);

    let output = `找到 ${results.length} 个匹配图标（显示前 ${limited.length} 个）：\n\n`;

    for (const r of limited) {
      const aliasStr = r.aliases.length > 0 ? `(别名: ${r.aliases.join(', ')})` : '';
      output += `- **${r.name}** — U+${r.codepoint.toString(16).toUpperCase()} (${r.codepoint}) ${aliasStr}\n`;
    }

    if (results.length > max_results) {
      output += `\n...还有 ${results.length - max_results} 个结果，请缩小搜索范围。`;
    }

    output += `\n\n🔗 在线预览: https://microsoft.github.io/vscode-codicons/dist/codicon.html\n📦 NPM: \`@vscode/codicons\``;
    return output;
  },
});
