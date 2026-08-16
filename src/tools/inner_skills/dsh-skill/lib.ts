/**
 * dsh-skill lib —— dsh（DeepSeek Harness）skill 兼容层的纯函数实现。
 *
 * 与 index.ts 分离的原因：seek-agent 的 inner_skill 加载器会把模块的
 * 所有导出当作工具注册（Object.entries(skillModule)），纯函数会因缺少
 * inputSchema 被序列化成 parameters: null 导致上游 400。因此 index.ts
 * 只导出工具，纯函数全部放这里。
 *
 * 兼容语义来源：deepseek-harness packages/skill/skill-filesystem/src/index.ts
 * （parseSkillFile / parseFrontmatter / parseInvocationPolicy / discoverRoot）。
 */

import { statSync } from 'node:fs'
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

// ─────────────────────────── frontmatter 解析 ───────────────────────────

/** dsh 规范的 kebab-case 名称校验。 */
export function isDshSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
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
 *   100 project-dsh    <cwd 所在 git 根>/.dsh/skills
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
      statSync(path.join(current, '.git'))
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
      // rank 更小（更优先）的覆盖
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

// ─────────────────────────── 目录缓存 ───────────────────────────

let catalogCache: DshSkillSummary[] | undefined
let cacheInvalidated = false

/** 获取（可选缓存）的 skill 目录；refresh 时强制重扫磁盘。 */
export async function getDshSkillCatalog(refresh?: boolean): Promise<DshSkillSummary[]> {
  if (refresh) cacheInvalidated = true
  if (catalogCache === undefined || cacheInvalidated) {
    catalogCache = await discoverDshSkills()
    cacheInvalidated = false
  }
  return catalogCache
}
