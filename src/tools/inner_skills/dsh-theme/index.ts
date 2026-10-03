/**
 * dsh-theme —— 主题皮肤加载器（DSH → seek-agent 移植）
 *
 * 本 skill 的价值全在「宿主 UI 那一半」：把为 DSH（DeepSeek Harness）编写的
 * 第三方皮肤包原样加载进 seek-agent。上游是 DSH 的 web 客户端插件，这里按
 * seek-agent 的实际结构重新落地：
 *   - host.mjs                    宿主半区（皮肤包 HTTP 托管），由 electron/main.js 动态 import
 *   - client/theme-loader.js      前端加载器（读 skin.json、注入 CSS、跑皮肤脚本）
 *   - client/escape-layer.js      转义层 A：把 seek-agent DOM 伪装成 DSH 结构
 *   - client/tokens.js            转义层 B：补齐 DSH 的 --dsw-* 令牌契约
 *   - themes/<id>/                皮肤包（skin.json + skin.css + skin.js + assets/）
 *   - enable.json                 总开关（enable / theme）
 *
 * 注意：inner_skill 跑在 agent 子进程里，而把前端注入 Electron 渲染层只有主进程能做。
 * 所以这里只导出「只读的状态查询」工具，供模型感知插件与皮肤状态。
 * 真正的加载/切换由主进程在窗口就绪时完成；运行时切换可提示用户在设置面板操作。
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
const THEMES_DIR = SKILL_DIR ? path.join(SKILL_DIR, 'themes') : ''

interface SkinInfo {
  id: string
  dir: string
  name: string
  version: string
  description: string
  tags: string[]
  active: boolean
}

/** 扫描 themes/ 下的皮肤包（跳过元信息损坏的）。 */
async function scanThemes(): Promise<SkinInfo[]> {
  const out: SkinInfo[] = []
  if (!THEMES_DIR) return out
  let entries: string[] = []
  try {
    entries = await readdir(THEMES_DIR)
  } catch {
    return out
  }
  let activeId = ''
  try {
    const cfg = JSON.parse(await readFile(path.join(SKILL_DIR, 'enable.json'), 'utf8'))
    activeId = cfg.theme || ''
  } catch {
    /* 读不到则无激活项 */
  }
  for (const dir of entries) {
    try {
      const raw = await readFile(path.join(THEMES_DIR, dir, 'skin.json'), 'utf8')
      const skin = JSON.parse(raw)
      const id = skin.id || dir
      out.push({
        id,
        dir,
        name: skin.name || dir,
        version: skin.version || '',
        description: skin.description || '',
        tags: Array.isArray(skin.tags) ? skin.tags : [],
        active: id === activeId,
      })
    } catch {
      /* 跳过损坏包 */
    }
  }
  return out
}

export const theme_list = tool({
  description:
    '列出 dsh-theme 插件已安装的 DSH 皮肤包（id、名称、版本、标签、是否为当前激活项）。' +
    '用户问「有哪些主题/皮肤」时用它。',
  inputSchema: z.object({}),
  execute: async () => {
    const skins = await scanThemes()
    if (skins.length === 0) {
      return { installed: 0, skins: [], hint: 'themes/ 目录下还没有皮肤包' }
    }
    return { installed: skins.length, skins }
  },
})

export const theme_status = tool({
  description:
    '查看 dsh-theme 插件的运行状态：总开关、当前激活皮肤、皮肤包目录位置。' +
    '排查「皮肤没生效」时先用它确认插件是否启用。',
  inputSchema: z.object({}),
  execute: async () => {
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(await readFile(path.join(SKILL_DIR, 'enable.json'), 'utf8'))
    } catch {
      /* 配置缺失 */
    }
    const skins = await scanThemes()
    return {
      enabled: cfg.enable !== false,
      activeTheme: cfg.theme || null,
      installed: skins.length,
      themesDir: THEMES_DIR,
      note: '宿主与转义层由 Electron 主进程在窗口就绪时装载；改动 enable.json 后需重启生效。',
    }
  },
})
