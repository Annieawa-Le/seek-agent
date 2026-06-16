import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { SKILLS_ROOT, isValidSkillName, isValidFileName } from './utils';

export const searchRef = tool({
  description: `在指定 skill 的 references 目录下的所有文件中搜索关键词，返回匹配的文件名、行号和内容`,
  inputSchema: z.object({
    skillName: z.string().describe('目标技能名称，如 desk-editor'),
    keyword: z.string().describe('要搜索的关键词（大小写不敏感）'),
  }),
  execute: async ({ skillName, keyword }): Promise<string> => {
    if (!isValidSkillName(skillName)) {
      return `⛔ 非法的 skill 名称："${skillName}"。`;
    }

    try {
      const refDir = path.join(SKILLS_ROOT, skillName, 'references');
      const entries = await fs.readdir(refDir, { withFileTypes: true });
      const files = entries.filter(e => e.isFile()).map(e => e.name);

      if (files.length === 0) {
        return `skill "${skillName}" 的 references/ 目录为空，未搜索到内容。`;
      }

      const results: string[] = [];
      const lowerKeyword = keyword.toLowerCase();

      for (const file of files) {
        if (!isValidFileName(file)) continue; // 跳过隐藏文件等

        const filePath = path.join(refDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerKeyword)) {
            results.push(`${file}:${i + 1}: ${lines[i]}`);
          }
        }
      }

      if (results.length === 0) {
        return `在 skill "${skillName}" 的 references 中未找到包含 "${keyword}" 的内容。`;
      }

      return `在 skill "${skillName}" 的 references 中找到 ${results.length} 处匹配：\n` + results.join('\n');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return `skill "${skillName}" 不存在或没有 references/ 目录。`;
      }
      return `搜索失败: ${err.message}`;
    }
  },
});
