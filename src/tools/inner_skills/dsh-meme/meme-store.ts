/**
 * 表情包图库内核 —— 移植自 dsh-meme（原 dsh-expression）的 memes.js，
 * 剥掉了 dsh 独有的部分（defineTool 工具注册、~/.dsh 图库扫描与远程订阅），
 * 只留纯图库逻辑。依赖 node:sqlite（Node ≥ 22.13 内置），零第三方依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { join, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'

/** 模型只认这 6 个情绪桶；磁盘上仍是细 tag（路径不改）。 */
export const MOODS: Record<string, string[]> = {
  happy: ['happy', 'like', 'meow', 'givemoney', 'color'],
  angry: ['angry', 'fool', 'baka'],
  sad: ['sad', 'sigh'],
  shy: ['shy'],
  confused: ['confused', 'surprised', 'see'],
  daily: ['daily', 'sleep', 'morning', 'work', 'cpu', 'reply'],
}

const MOOD_WORDS: Record<string, string> = {
  happy: '开心 高兴 兴奋 喜欢 卖萌 可爱 比心 哈哈 欢迎 得意 好耶 满意',
  angry: '生气 愤怒 暴躁 笨蛋 傻瓜 嫌弃 逮',
  sad: '难过 哭 委屈 叹气 无语 求饶 怂 晕',
  shy: '害羞 腼腆 脸红 花痴',
  confused: '困惑 疑惑 惊讶 问号 懵 惊吓 震惊',
  daily: '困 睡觉 早上好 打招呼 你好 上班 下班 摸鱼 工作 熬夜 吃饭 干饭 饿 日常',
}

export const MOOD_DICT =
  'happy 开心(卖萌/可爱/喜欢) / angry 生气 / sad 难过(无语/求饶) / shy 害羞 / confused 困惑惊讶 / daily 日常(睡觉/上班/早上好)'

export interface MemeRow {
  path: string
  tag: string
  file_name: string
  caption: string | null
  keywords: string
}

export function moodNames(): string[] {
  return Object.keys(MOODS)
}

function fineTagsFor(tag?: string | null): string[] | null {
  const t = String(tag || '').trim().toLowerCase()
  if (!t) return null
  if (MOODS[t]) return MOODS[t]
  for (const fine of Object.values(MOODS)) {
    if (fine.includes(t)) return [t]
  }
  return [t]
}

function moodsFromQuery(text: string): string[] {
  const hit: string[] = []
  for (const [mood, words] of Object.entries(MOOD_WORDS)) {
    if (words.split(/\s+/).some((w) => w && text.includes(w))) hit.push(mood)
  }
  return hit
}

/** tag 优先；否则用 query 里的口语词推断情绪。 */
export function resolveMood(tag?: string | null, query?: string | null): string | null {
  const t = String(tag || '').trim().toLowerCase()
  if (t) {
    if (MOODS[t]) return t
    for (const [mood, fine] of Object.entries(MOODS)) {
      if (fine.includes(t)) return mood
    }
  }
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  if (MOODS[q]) return q
  return moodsFromQuery(q)[0] || null
}

function pickRandom<T>(rows: T[], n: number): T[] {
  const copy = rows.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy.slice(0, n)
}

/** 关键词分词：空格/逗号/顿号/斜杠分隔，小写去重。中文词整词先搜，不预先切。 */
export function keywordTokens(query?: string | null): string[] {
  const raw = String(query || '').trim().toLowerCase()
  if (!raw) return []
  return [...new Set(raw.split(/[\s,，、;；/|]+/).filter(Boolean))]
}

/** 整词全都没命中时的兜底拆词：「生气猫」→ 生气 / 气猫。 */
function biGrams(tokens: string[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    if (t.length < 3 || !/[\u4e00-\u9fff]/.test(t)) continue
    for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2))
  }
  return [...new Set(out)]
}

const rowHay = (row: MemeRow) =>
  ((row.tag || '') + ' ' + (row.caption || '') + ' ' + (row.keywords || '') + ' ' + (row.file_name || '')).toLowerCase()

export interface SearchResult {
  query: string
  tokens: string[]
  memes: MemeRow[]
}

/**
 * 关键词搜图（纯函数）。
 * 排序：全部关键词都命中的优先；没有全命中就取命中词数最多的那一档；
 * 同一档内随机——同一个词反复 search 能换一批，不会每次都撞同一张。
 */
export function searchRows(rows: MemeRow[], query?: string | null, limit = 8): SearchResult {
  const tokens = keywordTokens(query)
  if (tokens.length === 0) return { query: '', tokens: [], memes: [] }
  const scan = (words: string[]) => {
    const hits: Array<{ row: MemeRow; score: number }> = []
    for (const row of rows) {
      const hay = rowHay(row)
      let score = 0
      for (const w of words) if (hay.includes(w)) score++
      if (score > 0) hits.push({ row, score })
    }
    return hits
  }
  let hits = scan(tokens)
  if (hits.length === 0) {
    const grams = biGrams(tokens)
    if (grams.length) hits = scan(grams)
  }
  if (hits.length === 0) return { query: tokens.join(' '), tokens, memes: [] }
  const best = Math.max(...hits.map((h) => h.score))
  return {
    query: tokens.join(' '),
    tokens,
    memes: pickRandom(hits.filter((h) => h.score === best).map((h) => h.row), limit),
  }
}

export function clampLimit(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x)) return 8
  return Math.max(1, Math.min(20, Math.floor(x)))
}

/** 打开一个图库目录（目录内须有 index.db）并只读查询。 */
export class MemesStore {
  root: string
  private db: any

  constructor(root: string) {
    this.root = resolve(root)
    const indexPath = join(this.root, 'index.db')
    if (!existsSync(indexPath)) throw new Error('缺少表情包索引: ' + indexPath)
    this.db = new DatabaseSync(indexPath, { readOnly: true })
  }

  private allRows(): MemeRow[] {
    return this.db
      .prepare("SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes")
      .all() as MemeRow[]
  }

  /** 列表情包：tag 为情绪桶或细分类；query 只做 caption/keywords 子串。 */
  list(tag?: string | null, query?: string | null): { memes: MemeRow[]; tags: string[] } {
    const rows = this.allRows()
    const tags = moodNames()
    let memes = rows
    const fine = fineTagsFor(tag)
    if (fine) memes = memes.filter((m) => fine.includes(m.tag))
    const q = query && String(query).trim().toLowerCase()
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean)
      memes = memes.filter((m) => {
        const hay = (m.tag + ' ' + (m.caption ?? '') + ' ' + (m.keywords ?? '')).toLowerCase()
        return tokens.some((t) => hay.includes(t))
      })
    }
    return { memes, tags }
  }

  /** 关键词搜图。给了 tag 就先把范围限在那个情绪桶里（细 tag 展开同 list）。 */
  search(query?: string | null, n = 8, tag?: string | null): SearchResult & { tags: string[] } {
    const rows = this.allRows()
    const fine = fineTagsFor(tag)
    const scoped = fine ? rows.filter((m) => fine.includes(m.tag)) : rows
    return { ...searchRows(scoped, query, n), tags: moodNames() }
  }

  /** 按情绪取池，随机抽 n 张给模型看 caption。 */
  sampleMood(tag?: string | null, query?: string | null, n = 5): { mood: string | null; memes: MemeRow[]; tags: string[] } {
    const mood = resolveMood(tag, query)
    if (!mood) return { mood: null, memes: [], tags: moodNames() }
    const { memes } = this.list(mood)
    return { mood, memes: pickRandom(memes, n), tags: moodNames() }
  }

  /** 把索引内相对路径解析为绝对路径（不允许逃出图库根）。 */
  resolveStored(stored: string): string {
    const target = resolve(this.root, stored)
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('路径超出表情包目录')
    }
    if (!existsSync(target)) throw new Error('文件不存在: ' + stored)
    return target
  }

  close(): void {
    try { this.db.close() } catch { /* 已关闭 */ }
  }
}
