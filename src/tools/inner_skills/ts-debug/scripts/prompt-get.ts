/**
 * prompt-get.ts — ts-debug-prompt-get 工具
 * 返回本技能的 SKILL.md 说明文档。
 */
import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const tsDebugPromptGet = tool({
  description: '获取 ts-debug 技能的详细说明文档（SKILL.md），包含可用工具列表和使用说明。',
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const skillPath = path.join(__dirname, '..', 'SKILL.md');
      return await fs.promises.readFile(skillPath, 'utf-8');
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});
