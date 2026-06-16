import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ghExplorerPromptGet = tool({
  description: `获取 gh-explorer 技能的详细说明文档（SKILL.md），包含可用工具列表和使用说明。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const skillPath = path.join(__dirname, '..', 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf-8');
      return content;
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});
