import { tool } from 'ai';
import { z } from 'zod';
import { isValidSkillName, readRefDir, listSkillsWithRefs } from './utils';

export const listRefs = tool({
  description: `列出指定 skill 的 references/ 目录下的所有文件，含文件大小。如不传入 skillName 则列出所有有参考文献的 skill。`,
  inputSchema: z.object({
    skillName: z.string().optional().describe('目标技能名称，如 desk-editor。不传则列出所有有参考文献的 skill。'),
  }),
  execute: async ({ skillName }): Promise<string> => {
    try {
      // 未指定 skillName → 列出所有有参考文献的 skill
      if (!skillName) {
        const skills = await listSkillsWithRefs();
        if (skills.length === 0) {
          return '当前没有任何 skill 拥有 references/ 目录。';
        }
        return '拥有参考文献的 skill：\n' + skills.join('\n');
      }

      // 校验 skillName
      if (!isValidSkillName(skillName)) {
        return `⛔ 非法的 skill 名称："${skillName}"。`;
      }

      const files = await readRefDir(skillName);
      if (files.length === 0) {
        return `skill "${skillName}" 的 references/ 目录为空。`;
      }

      // 格式化输出：文件名 + 大小
      const lines = files.map(f => {
        const sizeStr = f.size < 1024
          ? `${f.size} B`
          : `${(f.size / 1024).toFixed(1)} KB`;
        return `${f.name}  (${sizeStr})`;
      });

      return `skill "${skillName}" 的参考文献文件（共 ${files.length} 个）：\n` + lines.join('\n');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return `skill "${skillName}" 不存在或没有 references/ 目录。`;
      }
      return `读取失败: ${err.message}`;
    }
  },
});
