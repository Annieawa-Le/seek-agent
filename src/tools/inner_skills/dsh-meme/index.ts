/**
 * dsh-meme —— 表情包插件（DSH → seek-agent 移植）
 *
 * 与鲸鱼娘一样是「跨进程」插件，拆两半：
 *   - 工具半区（本文件，agent 进程）：send_meme 搜图；模型把 [表情: 描述] 原样写进回复。
 *   - web 半区（shim.mjs，Electron 主进程）：/dsh-memes 图片路由 + 注入 client.js 前端。
 * 图库内核见 meme-store.ts（移植自原插件 memes.js，node:sqlite，零第三方依赖）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemesStore, MOOD_DICT, clampLimit } from './meme-store'

const SKILL_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return ''
  }
})()

/** 内置图库（随插件分发的 dafeiyu-001）。 */
const MEME_ROOT = path.join(SKILL_DIR, 'memes', 'dafeiyu-001')

let store: MemesStore | null = null
let storeTried = false

function getStore(): MemesStore | null {
  if (!storeTried) {
    storeTried = true
    try {
      store = new MemesStore(MEME_ROOT)
    } catch {
      store = null
    }
  }
  return store
}

const lines = (rows: Array<{ caption: string | null; file_name: string }>) =>
  rows.map((m, i) => `${i + 1}. [表情: ${(m.caption || m.file_name).slice(0, 80)}]`)

export const send_meme = tool({
  description:
    '发一张表情包。两种搜法：①只给 tag(情绪) → 从该情绪里随机抽；' +
    '②给 query(关键词) → 在 caption/关键词/图名里搜，想找特定的图(「猫」「比心」「摸鱼」)就用这个；' +
    '两个都给 = 在该情绪里按关键词筛，最准。' +
    '流程：给 tag/query → 系统返回若干张候选(带 caption，数量用 limit 自己定) → ' +
    '看描述觉得贴，就把某一行的 [表情: 描述] 整段原样写进回复(描述抄候选原文，不要加网址)。' +
    `情绪字典: ${MOOD_DICT}。气氛对了就主动发；发完短接，让图自己说话。`,
  inputSchema: z.object({
    tag: z.string().optional().describe('情绪范围(可选)，如 happy / angry / sad / shy / confused / daily'),
    query: z.string().optional().describe('关键词(可选)：按 caption/关键词/图名子串搜，中文词空格分隔'),
    limit: z.number().optional().describe('本次返回几张候选(1-20，默认 8)'),
  }),
  execute: async ({ tag, query, limit }) => {
    const s = getStore()
    if (!s) return '表情包图库不可用（缺少 index.db）'

    const t = typeof tag === 'string' ? tag.trim().toLowerCase() : ''
    const q = typeof query === 'string' ? query.trim() : ''
    const n = clampLimit(limit)
    const howTo = '发图：把下面某一行的 [表情: ...] 整段原样写进回复（描述抄候选原文，不要加网址）。'

    // 关键词优先：有关键词就先精确搜，命中了直接给候选；全都没命中才退回按情绪抽。
    let keywordMiss = ''
    if (q) {
      const found = s.search(q, n, t)
      if (found.memes.length > 0) {
        return (
          `关键词「${found.query}」命中 ${found.memes.length} 张${t ? `(限在情绪 ${t} 里)` : ''}。` +
          `看 caption 贴就发；不满意再换词或加大 limit。\n${howTo}\n` +
          lines(found.memes).join('\n')
        )
      }
      keywordMiss = `关键词「${found.query || q}」没找到图(caption/关键词里没有这几个词)。`
    }

    const { mood, memes: candidates } = s.sampleMood(t, q, n)
    if (!mood) return keywordMiss + ` 给个情绪 tag 或换个更常见的词。字典: ${MOOD_DICT}`
    if (candidates.length === 0) return keywordMiss + `情绪「${mood}」下没有图。换一个: ${MOOD_DICT}`
    return (
      (keywordMiss ? keywordMiss + '下面按情绪抽：' : '') +
      `情绪 ${mood} 随机 ${candidates.length} 张。看 caption 贴就发；不满意再 search 同一 tag 换一批。\n${howTo}\n` +
      lines(candidates).join('\n')
    )
  },
})
