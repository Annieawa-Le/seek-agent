/**
 * skill-manager — 技能管理器
 *
 * 提供 reload_skills 工具，让 AI 或用户在不重启进程的情况下
 * 重新检测并加载所有 inner_skills 到运行中的进程。
 */

import { tool } from 'ai';
import { z } from 'zod';

export const reload_skills = tool({
  description: [
    '重新扫描并加载所有 inner_skills。',
    '新增或修改后的 skill 会被加载到当前进程中，无需重启。',
    '已存在的同名工具会被跳过（重名保护）。',
    '调用此工具后，新技能立即可用。',
  ].join(' '),
  inputSchema: z.object({}),
  execute: async () => {
    const { reloadSkills } = await import('../../index');
    return await reloadSkills();
  },
});
