/**
 * dsh-raw-html —— 视觉卡片（DSH → seek-agent 移植）
 *
 * 本 skill 的价值全在「宿主 UI 那一半」：把 AI 正文里的裸 HTML 渲染成视觉卡片。
 * 上游是 DSH Web 的 Cordis 插件（slot 协议替换 assistant-step 渲染器），这里按 seek-agent
 * 的实际结构重新落地：
 *   - host.mjs                 宿主半区（本地 HTTP 静态托管），由 electron/main.js 动态 import
 *   - client/raw-html.js       前端脚本（注册到渲染层内容扩展点）
 *   - client/sandbox-frame.js  隔离运行页（iframe 沙箱内渲染程序页 / 可信卡片）
 *   - client/engine-boot.js    引擎自注册片段（宿主在引擎响应尾部追加）
 *   - assets/vendor/           渲染引擎 + KaTeX + Mermaid + 色引擎
 *   - assets/fonts/            内置字体（@font-face 由宿主 /fonts.css 产出）
 *   - styles/*.md              美学风格库（12 套风格 + 索引 + 字体速查 + 兜底基准）
 *   - enable.json              总开关（enable / trusted）
 *
 * 注意：inner_skill 跑在 **agent 子进程**里，而把前端注入 Electron 渲染层只有 **主进程** 能做
 * （webContents）。所以这里不提供操作类工具，只导出「风格检索」与「状态查询」两个只读工具——
 * 前者是 M3 的落点（模型写卡前先取风格准则），后者让模型能感知插件状态。
 *
 * 与卡片的协作方式：模型在回复正文直接写 `<div id="vcp-root">…</div>`，无需任何工具调用；
 * 写法规范见 SYSTEM_INJECTION.md（自动注入 system prompt）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return ''
  }
})()
const STYLES_DIR = SKILL_DIR ? path.join(SKILL_DIR, 'styles') : ''

/** 风格 slug 白名单化：只允许库内实际存在的文件名，杜绝路径穿越 */
async function styleFiles(): Promise<string[]> {
  try {
    const names = await readdir(STYLES_DIR)
    return names.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

/** 风格索引行解析：`- slug — 标题 · 标签（关键词）` 形态，容忍破折号/空格差异 */
function parseIndexLines(text: string): Array<{ slug: string; desc: string }> {
  const out: Array<{ slug: string; desc: string }> = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*([a-z0-9][a-z0-9-]*)\s*[—–-]\s*(.+?)\s*$/.exec(line)
    if (m) out.push({ slug: m[1], desc: m[2] })
  }
  return out
}

export const style_list = tool({
  description:
    '列出「视觉卡片」美学风格库的全部风格（slug + 一句话定位）。写视觉卡片前先调它选风格，' +
    '再用 style_get 取该风格的完整准则。无合适风格时用 baseline 兜底。',
  inputSchema: z.object({}),
  execute: async () => {
    let indexText = ''
    try {
      indexText = await readFile(path.join(STYLES_DIR, '_INDEX.md'), 'utf-8')
    } catch {
      return '风格库不可用（styles/_INDEX.md 读取失败）。'
    }
    const lines = parseIndexLines(indexText)
    const files = await styleFiles()

    // 兜底：索引存在却解析不出任何风格行时，报清「为什么」而不是回一句空壳——
    // 静默返回空内容会让调用方拿到「没有 result」，且掩盖打包漏拷这类问题。
    if (lines.length === 0) {
      const realStyles = files.filter((f) => !f.startsWith('_'))
      return [
        '⚠ 风格库索引无法解析，未列出任何风格。',
        `索引文件：${path.join(STYLES_DIR, '_INDEX.md')}`,
        `同目录实际文件（${files.length} 个）：${files.join('、') || '（空）'}`,
        realStyles.length > 0
          ? `可直接用 style_get(slug) 取用：${realStyles.join('、')}`
          : '（未发现任何风格文件——打包时可能漏拷 styles/）',
      ].join('\n')
    }

    const extras = files.filter((f) => f.startsWith('_') && f !== '_INDEX')
    return [
      `视觉卡片 · 美学风格库（共 ${lines.length} 套）`,
      ...lines.map((l) => `- ${l.slug} — ${l.desc}`),
      '',
      `另有：_BASELINE（兜底基准库，无命中时用）、_FONTS（字体场景速查）`,
      extras.length ? `（库内文件：${extras.join('、')}）` : '',
      '',
      '取用：style_get(slug) 读某套风格全文；style_get("_BASELINE") 读兜底库。',
    ].filter(Boolean).join('\n')
  },
})

export const style_get = tool({
  description:
    '读取「视觉卡片」美学风格库中某一套风格的完整文档（色板 / 判断准则 / 示例素材 / 点睛技法）。' +
    'slug 来自 style_list；无合适风格时传 "_BASELINE"（兜底基准库）或 "_FONTS"（字体速查）。',
  inputSchema: z.object({
    slug: z.string().describe('风格 slug，如 porcelain-data / wabi-sabi / _BASELINE'),
  }),
  execute: async ({ slug }) => {
    const raw = String(slug || '').trim().replace(/\.md$/i, '')
    const files = await styleFiles()
    if (!files.includes(raw)) {
      return `未找到风格「${raw}」。可用：${files.join('、')}`
    }
    try {
      return await readFile(path.join(STYLES_DIR, raw + '.md'), 'utf-8')
    } catch (err) {
      return `读取风格「${raw}」失败：${(err as Error)?.message || err}`
    }
  },
})

export const raw_html_status = tool({
  description:
    '查看「视觉卡片」（dsh-raw-html 移植版）的启用状态、可信模式、字体清单与风格库规模。仅查询，不改变任何状态。',
  inputSchema: z.object({}),
  execute: async () => {
    let cfg: { enable?: boolean; trusted?: boolean } | null = null
    try {
      cfg = JSON.parse(await readFile(path.join(SKILL_DIR, 'enable.json'), 'utf-8'))
    } catch {
      /* enable.json 读不到（例如被编译搬走）时按未知处理 */
    }
    // 字体与风格库都是插件的运行时资源。打包若漏拷，这里会读到空目录——
    // 静默按「（无）」呈现会掩盖问题，所以显式区分「目录不存在」与「目录为空」。
    let fonts: string[] = []
    let fontsMissing = false
    try {
      fonts = (await readdir(path.join(SKILL_DIR, 'assets', 'fonts'))).filter((f) => f.endsWith('.woff2'))
    } catch {
      fontsMissing = true
    }
    const families = fonts.map((f) => f.replace(/\.woff2$/, ''))
    const styles = (await styleFiles()).filter((f) => !f.startsWith('_'))
    return [
      `视觉卡片：${cfg?.enable === false ? '已禁用' : '已启用'}`,
      `可信模式：${cfg?.trusted === true
        ? '开（卡内 <script> 在 iframe 沙箱内执行，触不到渲染层）'
        : '关（卡内 <script> 丢弃、不执行）'}`,
      `资源目录：${SKILL_DIR || '(未知)'}`,
      '宿主：Electron 主进程托管（读 enable.json → 动态 import host.mjs → 本地 HTTP → 注入前端）',
      '渲染：正文扩展点注册（渲染层对 VCP 协议零知识）；引擎 v1 流式增量渲染',
      '隔离：整页程序页与可信卡片走 iframe sandbox="allow-scripts"（不给 allow-same-origin）',
      fontsMissing
        ? '内置字体：⚠ 资源目录缺失（assets/fonts 不存在）——打包时可能漏拷插件资源'
        : `内置字体（${families.length} 款）：${families.join('、') || '⚠ 目录为空（打包漏拷？）'}`,
      styles.length > 0
        ? `美学风格库：${styles.length} 套（style_list 查看，style_get 取用）`
        : '美学风格库：⚠ 未读到任何风格（styles/ 缺失或为空；style_list 会报不可用）',
      '当前范围：M1 静态卡片 + M2 沙箱程序页/可信卡片 + M3 风格库',
      '卸载：删本目录即可，渲染层扩展点无注册者时走原 markdown 路径',
    ].join('\n')
  },
})

