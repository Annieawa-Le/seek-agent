/**
 * dsh-skill —— dsh（DeepSeek Harness）skill 兼容层（工具注册入口）
 *
 * 让按 dsh 规范编写的 skill（SKILL.md + YAML frontmatter，目录形态 <name>/SKILL.md
 * 或扁平形态 <name>.md）能无缝接入 seek-agent：
 *   - dsh_skill_catalog：列出可用 dsh skill 目录（name + description + whenToUse）
 *   - dsh_skill：按需加载某个 skill 的完整正文，返回 <skill_content> 指令块
 *
 * 注意：本文件只导出工具。seek-agent 的 inner_skill 加载器会把模块的所有导出
 * 当作工具注册（Object.entries(skillModule)），导出纯函数会因缺少 inputSchema
 * 被序列化成 parameters: null 导致上游 400（Invalid schema for function xxx）。
 * 所有解析/扫描纯函数在 ./lib.ts。
 */

import { tool } from 'ai'
import { z } from 'zod'
import {
  isDshSkillName,
  loadDshSkill,
  getDshSkillCatalog,
  type DshSkillSummary,
} from './lib'

function renderCatalog(entries: DshSkillSummary[]): string {
  if (entries.length === 0) {
    return '当前没有发现任何 dsh 规范 skill。可放置位置：工作区 .dsh/skills/ 或 .agents/skills/（目录 <name>/SKILL.md 或扁平 <name>.md），或用环境变量 SEEK_DSH_SKILL_DIRS 指定额外目录。'
  }
  const lines = entries.map((s) => {
    const when = s.whenToUse ? ` (适用：${s.whenToUse})` : ''
    return `- ${s.name}: ${s.description}${when} [来源 ${s.source}]`
  })
  return `可用 dsh skill（${entries.length} 个）：\n${lines.join('\n')}\n\n需要某个 skill 时用 dsh_skill 加载其完整正文。`
}

export const dsh_skill_catalog = tool({
  description: [
    '列出当前可用的 dsh（DeepSeek Harness）规范 skill 目录：name + description + whenToUse。',
    'dsh skill 是带 YAML frontmatter（name/description）的 SKILL.md 指令文档，',
    '分布在工作区 .dsh/skills/、.agents/skills/ 或环境变量 SEEK_DSH_SKILL_DIRS 指定的目录。',
    '任务与某个 skill 相关时，先用本工具查看目录，再用 dsh_skill 加载正文。',
  ].join(' '),
  inputSchema: z.object({
    refresh: z.boolean().optional().describe('是否强制重新扫描磁盘（默认使用缓存的目录）'),
  }),
  execute: async ({ refresh }) => {
    return renderCatalog(await getDshSkillCatalog(refresh))
  },
})

export const dsh_skill = tool({
  description: [
    '按名称加载一个 dsh（DeepSeek Harness）规范 skill 的完整正文（SKILL.md 的 frontmatter 之后部分）。',
    '返回 <skill_content> 指令块 + <skill_resources> 资源基准目录。',
    '仅在与当前任务相关时加载；加载后遵循其中的指令，需要资源文件时用文件工具读取。',
    'skill 名是 kebab-case，先可用 dsh_skill_catalog 查看有哪些。',
  ].join(' '),
  inputSchema: z.object({
    name: z.string().describe('dsh skill 名称（kebab-case，如 dsh-prose-standard）'),
  }),
  execute: async ({ name }) => {
    if (!isDshSkillName(name)) {
      return `"${name}" 不是合法的 dsh skill 名（需 kebab-case：小写字母+数字，连字符分隔）。`
    }
    const skill = await loadDshSkill(name)
    if (!skill) {
      return `未找到 dsh skill "${name}"。先用 dsh_skill_catalog 查看可用列表。`
    }
    if (!skill.modelInvocable) {
      return `dsh skill "${name}" 声明了 disable-model-invocation: true，模型不可调用。`
    }
    return [
      `<skill_content name="${skill.name}">`,
      skill.content,
      `</skill_content>`,
      ``,
      `<skill_resources>`,
      `该 skill 的资源基准目录：${skill.directory}（需要 scripts/references 等资源时用文件工具读取）`,
      `</skill_resources>`,
      `<skill_instructions>`,
      `以上指令仅在与当前任务相关时遵循；无关部分忽略。`,
      `</skill_instructions>`,
    ].join('\n')
  },
})

