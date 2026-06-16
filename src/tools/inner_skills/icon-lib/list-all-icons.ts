import { tool } from 'ai';
import { z } from 'zod';
import { loadMappingDataAsync, parseIcons } from './data';

export const listAllIcons = tool({
  description: `列出 Codicons 图标的分类概览（每组个数），不返回具体图标列表。适合先看有什么类别，再用 search_icons 或 prefix 深入。`,
  inputSchema: z.object({
    prefix: z.string().optional().describe('名称前缀筛选，如 "debug-", "arrow", "symbol-"，仅返回该前缀下的图标列表'),
  }),
  execute: async ({ prefix }): Promise<string> => {
    const mapping = await loadMappingDataAsync();
    const icons = parseIcons(mapping);

    // If prefix provided, list matching icons (this is intentionally scoped)
    if (prefix) {
      const pre = prefix.toLowerCase().trim();
      const matched = icons.filter(i =>
        i.primaryName.startsWith(pre) || i.aliases.some(a => a.startsWith(pre))
      );

      if (matched.length === 0) {
        return `没有匹配 "${prefix}" 的图标。`;
      }

      matched.sort((a, b) => a.codepoint - b.codepoint);
      let output = `"${prefix}" 前缀下共 ${matched.length} 个图标：\n`;
      for (const icon of matched) {
        const aliasStr = icon.aliases.length > 0 ? ` (别名: ${icon.aliases.join(', ')})` : '';
        output += `\n- \`${icon.primaryName}\` — U+${icon.codepoint.toString(16).toUpperCase()}${aliasStr}`;
      }
      return output;
    }

    // Categorize
    const groups: Record<string, { count: number; examples: string[] }> = {};
    const addToGroup = (name: string, groupKey: string, groupLabel: string) => {
      if (!groups[groupLabel]) groups[groupLabel] = { count: 0, examples: [] };
      groups[groupLabel].count++;
      if (groups[groupLabel].examples.length < 3) {
        groups[groupLabel].examples.push(name);
      }
    };

    for (const icon of icons) {
      const name = icon.primaryName;

      if (name.startsWith('symbol-')) addToGroup(name, 'symbol', 'symbol-* (代码符号)');
      else if (name.startsWith('debug-')) addToGroup(name, 'debug', 'debug-* (调试)');
      else if (name.startsWith('git-')) addToGroup(name, 'git', 'git-* (Git)');
      else if (name.startsWith('layout-')) addToGroup(name, 'layout', 'layout-* (编辑器布局)');
      else if (name.startsWith('terminal-')) addToGroup(name, 'terminal', 'terminal-* (终端)');
      else if (name.startsWith('chrome-')) addToGroup(name, 'chrome', 'chrome-* (窗口按钮)');
      else if (name.startsWith('arrow-')) addToGroup(name, 'arrow', 'arrow-* (箭头)');
      else if (name.startsWith('copilot-')) addToGroup(name, 'copilot', 'copilot-* (Copilot)');
      else if (name.startsWith('file-')) addToGroup(name, 'file', 'file-* (文件类型)');
      else if (name.startsWith('folder-')) addToGroup(name, 'folder', 'folder-* (文件夹)');
      else if (name.startsWith('repo-')) addToGroup(name, 'repo', 'repo-* (仓库)');
      else if (name.startsWith('comment-')) addToGroup(name, 'comment', 'comment-* (评论)');
      else if (name.startsWith('run-')) addToGroup(name, 'run', 'run-* (运行)');
      else if (name.startsWith('circle-')) addToGroup(name, 'circle', 'circle-* (圆形)');
      else if (name.startsWith('bell-')) addToGroup(name, 'bell', 'bell-* (通知)');
      else if (name.startsWith('search-')) addToGroup(name, 'search', 'search-* (搜索)');
      else if (name.startsWith('lightbulb-')) addToGroup(name, 'lightbulb', 'lightbulb-* (灯泡)');
      else if (name.startsWith('chevron-')) addToGroup(name, 'chevron', 'chevron-* (折叠箭头)');
      else if (name.startsWith('triangle-')) addToGroup(name, 'triangle', 'triangle-* (三角形)');
      else if (name.startsWith('vm-')) addToGroup(name, 'vm', 'vm-* (虚拟机)');
      else if (name.startsWith('diff-')) addToGroup(name, 'diff', 'diff-* (差异)');
      else if (name.startsWith('type-hierarchy')) addToGroup(name, 'type-hierarchy', 'type-hierarchy (类型层次)');
      else if (name.startsWith('keyboard-')) addToGroup(name, 'keyboard', 'keyboard-* (键盘)');
      else if (name.startsWith('chat-')) addToGroup(name, 'chat', 'chat-* (聊天/AI)');
      else if (name.startsWith('map-')) addToGroup(name, 'map', 'map-* (地图)');
      else if (name.startsWith('pass-')) addToGroup(name, 'pass', 'pass-* (通过/成功)');
      else if (name.startsWith('thumbs')) addToGroup(name, 'thumbs', 'thumbs-* (拇指)');
      else if (name.endsWith('-compact')) addToGroup(name, 'compact', '*-compact (12×12 紧凑版)');
      else addToGroup(name, 'other', '独立图标');
    }

    let output = `**Codicons 图标库概览** (共 ${icons.length} 个图标)\n\n`;

    const sortedGroups = Object.entries(groups).sort((a, b) => b[1].count - a[1].count);
    for (const [groupLabel, info] of sortedGroups) {
      const examples = info.examples.join(', ');
      output += `- **${groupLabel}**: ${info.count} 个 (如 ${examples}…)\n`;
    }

    output += `\n---`;
    output += `\n💡 想查看某类图标列表 → \`list_all_icons({ prefix: "debug-" })\``;
    output += `\n💡 想搜特定图标 → \`search_icons({ keyword: "..." })\``;
    return output;
  },
});
