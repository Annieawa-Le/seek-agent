/**
 * dsh-theme 宿主半区 —— 由 Electron 主进程动态 import 托管（inner_skill 的「宿主那一半」）。
 *
 * 职责：把 themes/ 下的皮肤包以 HTTP 托管给渲染层。
 *   GET /health                 健康检查（版本 + 皮肤清单）
 *   GET /skins                  皮肤清单（[{id, name, version, description, palette}]）
 *   GET /skins/<id>/skin.json   皮肤元信息
 *   GET /skins/<id>/<file>      皮肤包内任意文件（白名单：themes/<id>/ 目录内）
 *   GET /client/theme-loader.js 前端加载器（由 main.js 注入渲染层执行）
 *
 * 与 dsh-raw-html 同一套约定：零第三方依赖、路径白名单防穿越、删目录即卸载。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep, extname } from 'node:path'

export const DSH_THEME_VERSION = '0.1.0'

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

/**
 * @param {{ skillDir: string, autoActivate?: string }} opts
 *   skillDir     本插件目录（宿主按此解析 themes/ 与 client/）
 *   autoActivate 启动时自动激活的皮肤 id（来自 enable.json，可为空）
 */
export function createDshThemeHost({ skillDir, autoActivate = '' }) {
  const themesDir = join(skillDir, 'themes')
  const clientDir = join(skillDir, 'client')

  let server = null
  let port = 0

  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(body)
  }
  const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), MIME['.json'])

  /** 目录白名单读取（防目录穿越）。 */
  async function serveFrom(res, baseDir, rel) {
    const target = resolve(baseDir, rel)
    if (target !== baseDir && !target.startsWith(baseDir + sep)) return send(res, 403, 'forbidden')
    if (!existsSync(target)) return send(res, 404, 'not found')
    try {
      const data = await readFile(target)
      send(res, 200, data, MIME[extname(target).toLowerCase()] || 'application/octet-stream')
    } catch {
      send(res, 500, 'read error')
    }
  }

  /** 扫描 themes/ 下所有合法皮肤包。 */
  async function scanSkins() {
    const out = []
    if (!existsSync(themesDir)) return out
    let dirs = []
    try { dirs = await readdir(themesDir, { withFileTypes: true }) } catch { return out }
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue
      const metaPath = join(themesDir, entry.name, 'skin.json')
      if (!existsSync(metaPath)) continue
      try {
        const skin = JSON.parse(await readFile(metaPath, 'utf8'))
        out.push({
          id: skin.id || entry.name,
          dir: entry.name,
          name: skin.name || entry.name,
          nameEn: skin.nameEn || '',
          version: skin.version || '',
          description: skin.description || '',
          palette: skin.palette || null,
          tags: skin.tags || [],
          // 单色皮肤（'dark' / 'light'）会在加载期间锁住宿主亮暗，设置面板要据此提示
          colorScheme: skin.colorScheme || '',
        })
      } catch {
        /* 元信息损坏的皮肤包跳过 */
      }
    }
    return out
  }

  async function handler(req, res) {
    // file:// 页面 → http://127.0.0.1 属跨源，放开 CORS
    res.setHeader('Access-Control-Allow-Origin',
      req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === '/health') {
      const skins = await scanSkins()
      return json(res, {
        ok: true,
        plugin: 'dsh-theme',
        version: DSH_THEME_VERSION,
        capabilities: {
          skins: skins.length,
          autoActivate: autoActivate || (skins[0] ? skins[0].id : ''),
        },
      })
    }

    if (pathname === '/skins') {
      return json(res, { skins: await scanSkins() })
    }

    if (pathname.startsWith('/client/')) {
      const rel = pathname.slice('/client/'.length)
      return serveFrom(res, clientDir, rel)
    }

    if (pathname.startsWith('/skins/')) {
      const rest = pathname.slice('/skins/'.length)
      const slash = rest.indexOf('/')
      if (slash < 0) return send(res, 404, 'not found')
      const id = rest.slice(0, slash)
      const file = rest.slice(slash + 1)
      if (!file) return send(res, 404, 'not found')
      const skins = await scanSkins()
      // 允许用目录名或皮肤 id 访问（skin.json 的 id 可能与目录名不同）
      const found = skins.find((s) => s.id === id || s.dir === id)
      const dirName = found ? found.dir : id
      return serveFrom(res, join(themesDir, dirName), file)
    }

    return send(res, 404, 'not found')
  }

  return {
    async start() {
      server = createServer((req, res) => {
        handler(req, res).catch(() => {
          try { res.writeHead(500); res.end('error') } catch { /* 已发出 */ }
        })
      })
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      port = server.address().port
      return { port }
    },
    getPort: () => port,
    listSkins: scanSkins,
    clientDir,
    themesDir,
    stop() {
      try {
        if (server) {
          // 先掐掉 keep-alive 连接：只调 close() 的话，对端不主动断开就收不了摊，
          // 进程退出时还会留下半关状态的句柄（Windows 上表现为 libuv 断言崩溃）。
          server.closeAllConnections?.()
          server.close()
        }
      } catch { /* 已关闭 */ }
    },
  }
}
