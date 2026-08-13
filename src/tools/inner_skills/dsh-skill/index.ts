/**
 * dsh-skill —— dsh（DeepSeek Harness）skill 兼容层
 *
 * 让按 dsh 规范编写的 skill（SKILL.md + YAML frontmatter，目录形态 <name>/SKILL.md
 * 或扁平形态 <name>.md）能无缝接入 seek-agent：
 *   - 按 dsh 的发现根规范扫描（.dsh/skills、.agents/skills、自定义目录、用户目录）
 *   - 解析 SKILL.md 的 YAML frontmatter（name/description/whenToUse/
 *     disable-model-invocation/user-invocable/metadata），规则与 dsh skill-filesystem 对齐
 *   - dsh_skill_catalog：列出可用 dsh skill 目录（name + description + whenToUse）
 *   - dsh_skill：按需加载某个 skill 的完整正文，返回 <skill_content> 指令块
 *
 * 兼容语义来源：deepseek-harness packages/skill/skill-filesystem/src/index.ts
 * （parseSkillFile / parseFrontmatter / parseInvocationPolicy / discoverRoot）。
 */

import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** dsh 规范：skill 名 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 发现根 rank（与 dsh skill-filesystem 一致）。 */
const RANK_PROJECT_DSH = 100
const RANK_PROJECT_AGENTS = 200
const RANK_CUSTOM = 300
const RANK_USER_DSH = 400
const RANK_USER_AGENTS = 500

export interface DshSkillSummary {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: string
  rank: number
  /** SKILL.md 或 <name>.md 的绝对路径。 */
  path: string
  /** resourceBase：skill 所在目录（相对资源解析基准）。 */
  directory: string
  metadata?: Record<string, unknown>
}

export interface DshSkill extends DshSkillSummary {
  /** frontmatter 之后的正文（trim 后）。 */
  content: string
}

export interface DshSkillRoot {
  path: string
  source: string
  rank: number
}

// ─────────────────────────── 纯函数：frontmatter 解析 ───────────────────────────

/** dsh 规范的 kebab-case 名称校验。 */
export function isDshSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

/**
 * 极简 YAML 标量解析（frontmatter 字段均为标量或一层对象，如 metadata）。
 * 优先动态加载 'yaml' 包；未安装时用本解析器兜底，保证零依赖可用。
 */
async function parseYamlLoose(yaml: string): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = await import('yaml')
    const parsed = mod.parse(yaml) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return parseSimpleYaml(yaml)
  }
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++
      continue
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent === 0) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (!m) {
        i++
        continue
      }
      const key = m[1]!
      const rest = m[2]!
      if (rest === '') {
        // 空值：可能是 null 或后跟缩进块（一层 object）
        const next = lines[i + 1]
        if (next !== undefined && /^\s+/.test(next) && !/^\s*[-#]/.test(next) && !/^\s*$/.test(next)) {
          const obj: Record<string, unknown> = {}
          i++
          while (i < lines.length) {
            const sub = lines[i]!
            const subTrim = sub.trim()
            if (subTrim === '' || subTrim.startsWith('#')) {
              i++
              continue
            }
            if (!/^\s+/.test(sub) || /^\s*-/.test(sub)) break
            const sm = sub.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/)
            if (!sm) {
              i++
              continue
            }
            obj[sm[1]!] = yamlScalar(sm[2]!)
            i++
          }
          result[key] = obj
          continue
        }
        result[key] = null
        i++
      } else {
        result[key] = yamlScalar(rest)
        i++
      }
    } else {
      i++
    }
  }
  return result
}

function yamlScalar(raw: string): unknown {
  const t = raw.trim()
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"')
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1)
  if (t === 'true' || t === 'yes' || t === 'on') return true
  if (t === 'false' || t === 'no' || t === 'off') return false
  if (t === 'null' || t === '~' || t === '') return null
  if (/^-?\d+$/.test(t)) return parseInt(t, 10)
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t)
  return t
}

/**
 * 解析 dsh SKILL.md 文本：首行 '---' 到下一个 '---' 为 YAML frontmatter，其后为正文。
 * 规则与 dsh skill-filesystem 的 parseFrontmatter 对齐。
 */
export function parseDshSkillFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      const yaml = raw.slice(start, lineStart)
      const bodyStart = nextNewline < 0 ? raw.length : nextNewline + 1
      return { data: parseSimpleYaml(yaml), body: raw.slice(bodyStart) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  return undefined
}

/**
 * 解析单个 SKILL.md 文件为完整 skill。frontmatter 缺失/非法/缺必填字段/名称非法时返回 undefined。
 */
export async function parseDshSkillFile(filePath: string): Promise<DshSkill | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
  const parsed = parseDshSkillFrontmatter(raw)
  if (!parsed) return undefined
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (!name || !description) return undefined
  if (!isDshSkillName(name)) return undefined
  const disableModelInvocation = frontmatterBoolean(parsed.data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(parsed.data, 'user-invocable')
  const whenToUse = stringField(parsed.data, 'whenToUse')
  const metadataValue = parsed.data['metadata']
  const metadata = typeof metadataValue === 'object' && metadataValue !== null && !Array.isArray(metadataValue)
    ? metadataValue as Record<string, unknown>
    : undefined
  return {
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
    source: 'unknown',
    rank: RANK_CUSTOM,
    path: filePath,
    directory: path.dirname(filePath),
    ...(metadata !== undefined ? { metadata } : {}),
    content: parsed.body.trim(),
  }
}

// ─────────────────────────── 发现根与扫描 ───────────────────────────

/** 解析 SEEK_DSH_SKILL_DIRS 环境变量（分号或逗号分隔的绝对目录列表）。 */
export function customSkillDirsFromEnv(): string[] {
  const raw = process.env.SEEK_DSH_SKILL_DIRS
  if (!raw) return []
  return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean)
}

/**
 * 计算发现根（与 dsh skill-filesystem 的 roots() 对齐）：
 *   100 project-dsh   <cwd 所在 git 根>/.dsh/skills
 *   200 project-agents <cwd 所在 git 根>/.agents/skills
 *   300 custom         SEEK_DSH_SKILL_DIRS
 *   400 user-dsh       ~/.dsh/skills
 *   500 user-agents    ~/.agents/skills
 * 找不到 git 根时退化为 cwd 本身。
 */
export function resolveDshSkillRoots(cwd?: string): DshSkillRoot[] {
  const base = cwd ?? process.cwd()
  const projectRoot = findGitRootSync(base) ?? base
  const home = os.homedir()
  const roots: DshSkillRoot[] = [
    { path: path.join(projectRoot, '.dsh', 'skills'), source: 'project-dsh', rank: RANK_PROJECT_DSH },
    { path: path.join(projectRoot, '.agents', 'skills'), source: 'project-agents', rank: RANK_PROJECT_AGENTS },
  ]
  for (const dir of customSkillDirsFromEnv()) {
    roots.push({ path: dir, source: 'custom', rank: RANK_CUSTOM })
  }
  roots.push(
    { path: path.join(home, '.dsh', 'skills'), source: 'user-dsh', rank: RANK_USER_DSH },
    { path: path.join(home, '.agents', 'skills'), source: 'user-agents', rank: RANK_USER_AGENTS },
  )
  return roots
}

function findGitRootSync(start: string): string | undefined {
  let current = path.resolve(start)
  for (;;) {
    try {
      fs.statSync(path.join(current, '.git'))
      return current
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

/**
 * 扫描所有发现根，返回排序后的 skill 摘要（同层内按 name 字典序，rank 优先）。
 * 目录形态 <name>/SKILL.md 与扁平形态 <name>.md 均被识别；解析失败静默跳过。
 */
export async function discoverDshSkills(cwd?: string): Promise<DshSkillSummary[]> {
  const roots = resolveDshSkillRoots(cwd)
  const found = new Map<string, DshSkillSummary>()
  for (const root of roots) {
    let entries: { name: string; path: string; isDir: boolean }[]
    try {
      const raw = await fs.readdir(root.path, { withFileTypes: true })
      entries = raw.map(e => ({ name: e.name, path: path.join(root.path, e.name), isDir: e.isDirectory() }))
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.system') continue
      const skillPath = entry.isDir
        ? path.join(entry.path, 'SKILL.md')
        : entry.name.endsWith('.md') ? entry.path : undefined
      if (!skillPath) continue
      const skill = await parseDshSkillFile(skillPath)
      if (!skill) continue
      const summary: DshSkillSummary = { ...skill }
      const existing = found.get(skill.name)
      // 同层 rank 决定谁赢；rank 更小（更优先）的覆盖
      if (!existing || root.rank < existing.rank) {
        found.set(skill.name, { ...summary, source: root.source, rank: root.rank })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 按名称加载 skill 全文（每次实时读盘，保证正文最新）。 */
export async function loadDshSkill(name: string, cwd?: string): Promise<DshSkill | undefined> {
  const summaries = await discoverDshSkills(cwd)
  const summary = summaries.find(s => s.name === name)
  if (!summary) return undefined
  return await parseDshSkillFile(summary.path)
}

// ─────────────────────────── 工具注册 ───────────────────────────

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
    if (refresh) {
      cacheInvalidated = true
    }
    return renderCatalog(await getCatalog())
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

// ─────────────────────────── 目录缓存 ───────────────────────────

let catalogCache: DshSkillSummary[] | undefined
let cacheInvalidated = false

async function getCatalog(): Promise<DshSkillSummary[]> {
  if (catalogCache === undefined || cacheInvalidated) {
    catalogCache = await discoverDshSkills()
    cacheInvalidated = false
  }
  return catalogCache
}
