import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { SKILLS_ROOT, isValidFileName, listSkillsWithRefs } from './utils';

export const findRef = tool({
  description: `在所有 skills 的 references/ 目录中按文件名模式查找文件`,
  inputSchema: z.object({
    pattern: z.string().describe('文件名模式（支持 * 和 ? 通配符，如 *.md、architecture.*）'),
  }),
  execute: async ({ pattern }): Promise<string> => {
    try {
      const skills = await listSkillsWithRefs();

      // 将 glob 风格的通配符转为正则
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`^${regexStr}$`, 'i');

      const matches: { skill: string; file: string }[] = [];

      for (const skill of skills) {
        const refDir = path.join(SKILLS_ROOT, skill, 'references');
        try {
          const entries = await fs.readdir(refDir, { withFileTypes: true });
          const files = entries.filter(e => e.isFile()).map(e => e.name);
          for (const file of files) {
            if (isValidFileName(file) && regex.test(file)) {
              matches.push({ skill, file });
            }
          }
        } catch {
          continue;
        }
      }

      if (matches.length === 0) {
        return `未找到文件名匹配 "${pattern}" 的参考文献文件。`;
      }

      const result = matches.map(m => `[${m.skill}] ${m.file}`).join('\n');
      return `找到 ${matches.length} 个匹配的文件：\n${result}`;
    } catch (error) {
      return `查找失败: ${(error as Error).message}`;
    }
  },
});
