import { tool } from 'ai';
import { z } from 'zod';
import { loadMappingDataAsync, parseIcons, getDetailedEntry } from './data';
import fs from 'fs/promises';
import fs from 'fs/promises';

export const getIconDetail = tool({
  description: `获取指定 Codicons 图标的详细信息，包括主名称、别名、codepoint（Unicode 字符和十六进制值）、CSS class、本地 SVG 路径和内容、在线预览链接及使用示例。`,
  inputSchema: z.object({
    icon_name: z.string().describe('图标主名称，如 "add", "arrow-down", "debug-start", "settings-gear"'),
  }),
  execute: async ({ icon_name }): Promise<string> => {
    const name = icon_name.toLowerCase().trim();
    if (!name) return '请输入图标名称。';

    const mapping = await loadMappingDataAsync();
    const icons = parseIcons(mapping);

    let found = icons.find(i => i.primaryName === name);
    if (!found) {
      found = icons.find(i => i.aliases.some(a => a === name));
    }

    if (!found) {
      return `未找到图标 "${icon_name}"。使用 search_icons 搜索相关图标。`;
    }

    const detail = getDetailedEntry(found);

    // 尝试读取本地 SVG
    let svgContent = '';
    try {
      svgContent = await fs.readFile(detail.localSvgPath, 'utf-8');
    } catch {
      svgContent = '(本地文件不可用)';
    }

    let output = `## ${detail.primaryName}\n\n`;
    output += `| 属性 | 值 |\n`;
    output += `|------|-----|\n`;
    output += `| **主名称** | \`${detail.primaryName}\` |\n`;
    output += `| **别名** | ${detail.aliases.length > 0 ? detail.aliases.map(a => '`' + a + '`').join(', ') : '无'} |\n`;
    output += `| **Codepoint** | ${detail.codepoint} |\n`;
    output += `| **Unicode** | ${detail.unicodeHex} (字符: \`${detail.unicodeChar}\`) |\n`;
    output += `| **CSS Class** | \`${detail.cssClass}\` |\n`;
    output += `| **本地 SVG** | \`${detail.localSvgPath}\` |\n`;
    output += `| **GitHub 源** | [${detail.primaryName}.svg](${detail.svgUrl}) |\n`;
    output += `| **在线预览** | [查看](${detail.codiconCdnUrl}) |\n`;

    output += `\n### SVG 内容\n\n`;
    output += '```svg\n' + svgContent + '\n```\n';

    output += `\n### 使用方式\n\n`;
    output += `**HTML (字体图标):**\n`;
    output += '```html\n<i class="' + detail.cssClass + '"></i>\n```\n';
    output += `**HTML (SVG Sprite):**\n`;
    output += '```html\n<svg><use xlink:href="codicon.svg#' + detail.primaryName + '" /></svg>\n```\n';
    const reactName = detail.primaryName.replace(/-./g, m => m[1].toUpperCase());
    output += `**React:**\n`;
    output += '```tsx\nimport { ' + reactName + " } from '@vscode/codicons';\n```\n";

    return output;
  },
});

