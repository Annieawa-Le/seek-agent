import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { SKILLS_ROOT, isValidSkillName, isValidFileName } from './utils';

export const readRef = tool({
  description: `读取指定 skill 中某个参考文献文件的内容`,
  inputSchema: z.object({
    skillName: z.string().describe('目标技能名称，如 desk-editor'),
    fileName: z.string().describe('参考文献文件名（不含路径，如 architecture.md）'),
  }),
  execute: async ({ skillName, fileName }): Promise<string> => {
    if (!isValidSkillName(skillName)) {
      return `⛔ 非法的 skill 名称："${skillName}"。`;
    }
    if (!isValidFileName(fileName)) {
      return `⛔ 非法的文件名："${fileName}"。`;
    }

    try {
      const filePath = path.join(SKILLS_ROOT, skillName, 'references', fileName);
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return `未找到文件：skill "${skillName}" 的 references/ 目录下不存在 "${fileName}"。`;
      }
      return `读取失败: ${err.message}`;
    }
  },
});
