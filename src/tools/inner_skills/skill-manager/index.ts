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


export const remove_skill = tool({
  description: [
    '卸载一个 inner_skill 及其所有工具。',
    '给定技能名（目录名），从运行进程中移除该技能注册的所有工具。',
    '核心工具不受影响。',
    '重新加载（reload_skills）可恢复被卸载的技能。',
  ].join(' '),
  inputSchema: z.object({
    skill_name: z.string().describe('要卸载的技能名称（即 inner_skills 下的目录名，如 "icon-lib"）'),
  }),
  execute: async ({ skill_name }) => {
    const { removeSkill } = await import('../../index');
    const removed = removeSkill(skill_name);
    if (removed.length === 0) return `未找到技能 "${skill_name}" 或该技能没有可卸载的工具。`;
    return `已卸载技能 "${skill_name}"，移除 ${removed.length} 个工具：${removed.join(', ')}`;
  },
});

export const remove_tool = tool({
  description: [
    '卸载指定的单个工具。',
    '给定工具名，从运行进程中移除该工具。',
    '核心工具不可卸载。',
    '重新加载（reload_skills）可恢复被卸载的工具。',
  ].join(' '),
  inputSchema: z.object({
    tool_name: z.string().describe('要卸载的工具名称，如 "search_icons"'),
  }),
  execute: async ({ tool_name }) => {
    const { removeTool } = await import('../../index');
    const skill = removeTool(tool_name);
    if (skill === null) return `"${tool_name}" 是核心工具，不可卸载。`;
    if (skill === '__anonymous__') return `已卸载工具 "${tool_name}"（无归属技能）。`;
    return `已从技能 "${skill}" 中卸载工具 "${tool_name}"。`;
  },
});
