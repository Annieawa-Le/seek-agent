/**
 * dsh-meme web 半区 —— 由 Electron 主进程托管（本文件被 main.js 动态 import）。
 *
 * 与鲸鱼娘的假 DSH 壳不同：dsh-meme 的宿主后端要 tools/attachments/llm 一堆服务，
 * 跑不动，所以这里只重写它真正对外暴露的两件事：
 *   1. GET /dsh-memes/<path>      图片本体（白名单 = 图库根内文件）
 *   2. GET /dsh-memes-api         图库索引（caption/keywords → 图片 URL 映射，供前端配图）
 * 前端脚本（client.dom.js）由 main.js 注入渲染层，走 DOM 装饰。
 *
 * 依赖：node:http + node:sqlite（Node ≥22.13），零第三方依赖。
 */
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep, extname } from 'node:path'

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
}

export function createMemeHost({ skillDir }) {
  const memeRoot = join(skillDir, 'memes', 'dafeiyu-001')
  let server = null
  let port = 0

  const readIndex = () => {
    const db = new DatabaseSync(join(memeRoot, 'index.db'), { readOnly: true })
    try {
      return db
        .prepare("SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes")
        .all()
    } finally {
      db.close()
    }
  }

  const json = (res, obj, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(JSON.stringify(obj))
  }

  const serveFile = async (res, file, type) => {
    try {
      const data = await readFile(file)
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }

  const handler = async (req, res) => {
    // file:// 页面 → http://127.0.0.1 是跨源，放开 CORS（main.js 另有请求头改写）
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === '/dsh-memes-api') {
      try {
        const memes = readIndex().map((r) => ({
          path: r.path,
          tag: r.tag,
          caption: r.caption,
          keywords: r.keywords,
          file_name: r.file_name,
          url: '/dsh-memes/' + r.path,
        }))
        return json(res, { ok: true, memes, total: memes.length, packId: 'dafeiyu-001' })
      } catch (e) {
        return json(res, { ok: false, error: String((e && e.message) || e) }, 500)
      }
    }

    if (pathname.startsWith('/dsh-memes/')) {
      const rel = pathname.slice('/dsh-memes/'.length)
      const target = resolve(memeRoot, rel)
      if ((target !== memeRoot && !target.startsWith(memeRoot + sep)) || !existsSync(target)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      return serveFile(res, target, MIME[extname(target).toLowerCase()] || 'application/octet-stream')
    }

    res.writeHead(404)
    res.end('not found')
  }

  return {
    async start() {
      server = createServer((req, res) => {
        handler(req, res).catch(() => {
          try { res.writeHead(500); res.end('error') } catch { /* ignore */ }
        })
      })
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      port = server.address().port
      return { port }
    },
    getPort: () => port,
    memeRoot,
    stop() {
      try { if (server) server.close() } catch { /* ignore */ }
    },
  }
}
