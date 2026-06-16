/**
 * skill-creator skill 入口
 * 提供创建和管理 inner_skills 的工具：create_skill、list_skills、skill_creator_prompt_get
 */
import {
  createSkill,
  listSkills,
  skillCreatorPromptGet,
} from './create-skill';

const tools: Record<string, any> = {
  create_skill: createSkill,
  list_skills: listSkills,
  'skill-creator-prompt-get': skillCreatorPromptGet,
};

export default tools;
