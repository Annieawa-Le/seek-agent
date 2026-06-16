import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

export const mcGenLang = tool({
  description: `生成或更新模组的语言文件（JSON），支持多语言。自动追加新的翻译条目到已有文件中，避免覆盖已有内容。`,
  inputSchema: z.object({
    modId: z.string().describe('模组 ID'),
    language: z.string().describe('语言代码，如 en_us / zh_cn / ja_jp'),
    translations: z.string().describe('翻译条目 JSON 字符串，格式 {"item.mod_id.ruby": "Ruby", "block.mod_id.ruby_ore": "Ruby Ore"}'),
    outputPath: z.string().describe('输出目录路径（项目根目录）'),
  }),
  execute: async ({ modId, language, translations, outputPath }): Promise<string> => {
    const langDir = path.join(outputPath, 'src', 'main', 'resources', 'assets', modId, 'lang');
    await fs.mkdir(langDir, { recursive: true });

    const langFilePath = path.join(langDir, `${language}.json`);

    let existing: Record<string, string> = {};
    try {
      const existingContent = await fs.readFile(langFilePath, 'utf-8');
      existing = JSON.parse(existingContent);
    } catch {
      // 文件不存在或解析失败，从头开始
    }

    let newEntries: Record<string, string> = {};
    try {
      newEntries = JSON.parse(translations);
    } catch {
      return `❌ translations 参数不是合法的 JSON 字符串：${translations}`;
    }

    const merged = { ...existing, ...newEntries };
    const added: string[] = [];
    const skipped: string[] = [];

    for (const [key, value] of Object.entries(newEntries)) {
      if (existing[key] === undefined) {
        added.push(key);
      } else if (existing[key] !== value) {
        added.push(key);
      } else {
        skipped.push(key);
      }
    }

    await fs.writeFile(langFilePath, JSON.stringify(merged, null, 2), 'utf-8');

    const lines = [
      `✅ 语言文件已更新：assets/${modId}/lang/${language}.json`,
      '',
    ];

    if (added.length > 0) {
      lines.push(`✨ 新增/更新 ${added.length} 条翻译：`);
      added.forEach(k => lines.push(`  - ${k}: "${merged[k]}"`));
    }

    if (skipped.length > 0) {
      lines.push('', `⏭️ 跳过 ${skipped.length} 条未变更的条目`);
    }

    lines.push('', `📦 当前翻译总数：${Object.keys(merged).length} 条`);

    return lines.join('\n');
  },
});
