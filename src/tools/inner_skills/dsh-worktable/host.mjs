/**
 * dsh-worktable 宿主半区 —— 由 Electron 主进程动态 import 托管（本文件是 inner_skill 的「宿主那一半」）。
 *
 * 与上游（DSH Cordis 插件）的差别：
 *   上游是「宿主路由 /api/worktable/* + 客户端 bundle 走 slot 协议注入」，两半通过 HTTP 与宿主
 *   会话服务耦合；这里我们把宿主那一半缩到最小——它只负责本地资源托管，会话/文件/命令等能力
 *   一律不在这一层重复实现（前端注入渲染层后可直接用 window.electronAPI）。
 *
 * 当前提供：
 *   GET /wt/health            健康检查（版本、能力清单），供主进程/调试自检
 *   GET /wt/client/<path>     插件前端资源（client/ 目录内，白名单限制在目录内）
 * 预留给 M2（终端 / 浏览器 / 静态站点窗格）：
 *   GET /wt/site/<token>/...  项目内静态站点托管（当前返回 501）
 *
 * 依赖：node:http + node:fs，零第三方依赖。
 * 卸载：删掉本目录即可，主进程动态 import 失败会被捕获，不影响主功能。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep, extname } from 'node:path'

export const WORKTABLE_VERSION = '0.1.0'

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
}

/**
 * @param {{ skillDir: string }} opts skillDir = 本插件目录（宿主按此解析 client/ 等资源）
 */
export function createWorktableHost({ skillDir }) {
  const clientDir = join(skillDir, 'client')
  let server = null
  let port = 0

  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(body)
  }

  const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), MIME['.json'])

  /** 只允许读 client/ 目录内的文件（防目录穿越）。 */
  async function serveClient(res, rel) {
    const target = resolve(clientDir, rel)
    if (target !== clientDir && !target.startsWith(clientDir + sep)) return send(res, 403, 'forbidden')
    if (!existsSync(target)) return send(res, 404, 'not found')
    try {
      const data = await readFile(target)
      send(res, 200, data, MIME[extname(target).toLowerCase()] || 'application/octet-stream')
    } catch {
      send(res, 500, 'read error')
    }
  }

  async function handler(req, res) {
    // file:// 页面 → http://127.0.0.1 属于跨源，放开 CORS（主进程另有请求头改写）
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === '/wt/health') {
      return json(res, {
        ok: true,
        plugin: 'dsh-worktable',
        version: WORKTABLE_VERSION,
        // 能力清单：前端按此判断哪些窗格可用（当前均为占位，M2 逐项落地）
        capabilities: { drawer: true, stage: true, console: true, split: false, explorer: false, terminal: false, browser: false, site: false },
      })
    }

    if (pathname.startsWith('/wt/client/')) {
      return serveClient(res, pathname.slice('/wt/client/'.length))
    }

    if (pathname.startsWith('/wt/site/')) {
      // M2：项目内静态站点托管（浏览器/动画窗格加载项目目录下的网页）
      return json(res, { ok: false, error: 'site hosting not implemented yet' }, 501)
    }

    return send(res, 404, 'not found')
  }

  return {
    async start() {
      server = createServer((req, res) => {
        handler(req, res).catch(() => {
          try {
            res.writeHead(500)
            res.end('error')
          } catch {
            /* 响应已发出，忽略 */
          }
        })
      })
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      port = server.address().port
      return { port }
    },
    getPort: () => port,
    clientDir,
    stop() {
      try {
        if (server) server.close()
      } catch {
        /* 已关闭 */
      }
    },
  }
}
