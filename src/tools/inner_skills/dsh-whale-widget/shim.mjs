/**
 * dsh-whale-widget 的「假 DSH 宿主」（shim）。
 *
 * dsh-whale-widget 是标准 DSH bundle 插件，但它的 lib/index.js **不 import 任何 dsh npm 包**——
 * 它对 DSH 的全部依赖都走注入进来的 ctx。所以这里实现一个最小 ctx，就能把它原样跑起来，
 * 让它以为自己在 DSH 里；前端 assets/whale-widget.js 也原样复用。
 *
 * shim 的 ctx API 清单来自 lib/index.js 的实际使用（逐条核对）：
 *   root.effect(fn)                          —— fn 返回 cleanup，注册到生命周期
 *   root.on('webserver/index-inject', cb)    —— 桌面端注入通道，cb(table) 往 table 塞注入行
 *   root.inject(services, cb)                —— 服务就绪后回调（假服务始终就绪）
 *   ctx.get(name)                            —— 可选服务，全返回 undefined（插件有 fallback）
 *   ctx.credentials.resolve|set|delete       —— 凭据读写
 *   ctx.webServer.register({kind,path,handler}) / tapIndex(fn) —— 注册 HTTP 路由 / 页面注入
 *   ctx.on('session/event'|'session/disposed', cb) —— 会话事件
 *
 * route.handler 是标准 Node (req, res)，所以直接挂到 http.createServer 即可，零适配。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * 创建一个假 DSH 宿主。
 * @param {object} options
 * @param {string} options.widgetDir   dsh-whale-widget 包根目录（含 lib/ 与 assets/）
 * @param {string} [options.dataDir]   数据目录（默认 ~/.seek-agent/whale），插件账本/角色/音频都落这里
 * @param {string} [options.credentialsFile] 凭据文件（默认 dataDir/credentials.json）
 * @param {number} [options.port]      监听端口，0 = 随机
 */
export function createWhaleHost(options = {}) {
  const widgetDir = options.widgetDir
  const dataDir = options.dataDir || path.join(os.homedir(), '.seek-agent', 'whale')
  fs.mkdirSync(dataDir, { recursive: true })

  // 让插件的数据文件落在 seek-agent 自己的目录，而不是用户的 ~/.dsh
  // （必须在 import lib/index.js 之前设置——它的 top-level 常量会读这个环境变量）
  if (!process.env.DSH_HOME) process.env.DSH_HOME = dataDir

  const routes = []
  const disposers = []
  const listeners = new Map()
  const indexTaps = []

  // ───────────────────────── 凭据 ─────────────────────────
  const credFile = options.credentialsFile || path.join(dataDir, 'credentials.json')
  const readCreds = () => {
    try { return JSON.parse(fs.readFileSync(credFile, 'utf8')) || {} } catch { return {} }
  }
  const writeCreds = (obj) => {
    fs.mkdirSync(path.dirname(credFile), { recursive: true })
    fs.writeFileSync(credFile, JSON.stringify(obj, null, 2), 'utf8')
  }

  const credentials = {
    async resolve(key) {
      const value = readCreds()[key]
      if (value !== undefined && value !== null && value !== '') return { value: String(value) }
      // 回退：seek-agent 的环境变量（main.js 会在启动宿主前按 provider 预置好对应凭据名）
      const env = process.env[key]
      if (env) return { value: String(env) }
      const err = new Error('credential not found: ' + key)
      err.code = 'CREDENTIAL_NOT_FOUND'
      throw err
    },
    async set(key, value) {
      const creds = readCreds()
      creds[key] = String(value)
      writeCreds(creds)
    },
    async delete(key) {
      const creds = readCreds()
      delete creds[key]
      writeCreds(creds)
    },
  }

  // ───────────────────────── webServer ─────────────────────────
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    tapIndex(fn) {
      indexTaps.push(fn)
      return () => {
        const i = indexTaps.indexOf(fn)
        if (i >= 0) indexTaps.splice(i, 1)
      }
    },
  }

  // ───────────────────────── 假 ctx ─────────────────────────
  const ctx = {
    // 可选服务（connection / sessionTitle / deepseekAccount）：插件对每个都有 fallback
    get: () => undefined,
    credentials,
    webServer,
    on(event, cb) {
      const arr = listeners.get(event) || []
      arr.push(cb)
      listeners.set(event, arr)
      return () => {
        const a = listeners.get(event) || []
        const i = a.indexOf(cb)
        if (i >= 0) a.splice(i, 1)
      }
    },
    effect(fn) {
      try {
        const r = fn()
        if (typeof r === 'function') disposers.push(r)
      } catch (err) {
        console.error('[whale-shim] effect error:', err)
      }
    },
    inject(_services, cb) {
      // 假服务始终「就绪」，立即回调
      try {
        cb(ctx)
      } catch (err) {
        console.error('[whale-shim] inject callback error:', err)
      }
    },
  }

  // ───────────────────────── HTTP ─────────────────────────
  let server = null
  let port = 0

  function matchRoute(pathname) {
    for (const r of routes) {
      if (r && typeof r.handler === 'function' && (r.kind === 'exact' || !r.kind) && r.path === pathname) return r
    }
    // 非 exact（前缀型）兜底
    for (const r of routes) {
      if (r && typeof r.handler === 'function' && r.kind && r.kind !== 'exact' && typeof r.path === 'string' && pathname.startsWith(r.path)) return r
    }
    return null
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      // 允许前端从 file:// 或其它本地 origin 跨源读取（widget 图为 no-cors 资源，fetch 需要 CORS）
      const origin = req.headers.origin
      res.setHeader('Access-Control-Allow-Origin', origin || '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      const route = matchRoute(url.pathname)
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found: ' + url.pathname)
        return
      }
      await route.handler(req, res)
    } catch (err) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('whale-shim error: ' + String((err && err.message) || err))
      } catch {
        /* 响应可能已发出 */
      }
    }
  }

  /** 加载插件并启动 HTTP server，返回 { port, injections }。 */
  async function start() {
    server = http.createServer((req, res) => { void handle(req, res) })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, '127.0.0.1', resolve)
    })
    port = server.address().port

    // 触发桌面端注入通道，收集插件自带的注入行（一段建 <script src="/dsh-whale/widget.js"> 的内联代码）
    const table = []
    for (const cb of listeners.get('webserver/index-inject') || []) {
      try {
        cb(table)
      } catch (err) {
        console.error('[whale-shim] index-inject error:', err)
      }
    }

    return { port, injections: table }
  }

  /** import 插件模块并 apply。须在 start() 之前或之后调用皆可（路由注册不依赖 server）。 */
  async function loadPlugin() {
    const entry = pathToFileURL(path.join(widgetDir, 'lib', 'index.js')).href
    const mod = await import(entry)
    const plugin = mod.default || mod
    if (!plugin || typeof plugin.apply !== 'function') {
      throw new Error('dsh-whale-widget: 未找到插件的 apply()')
    }
    plugin.apply(ctx)
  }

  /** 把一条 DSH 形状的会话事件喂给插件（session: {id,name?,...}, event: {type,data}）。 */
  function emitSessionEvent(session, event) {
    for (const cb of listeners.get('session/event') || []) {
      try {
        cb(session, event)
      } catch (err) {
        console.error('[whale-shim] session/event error:', err)
      }
    }
  }

  function emitSessionDisposed(session) {
    for (const cb of listeners.get('session/disposed') || []) {
      try {
        cb(session)
      } catch (err) {
        console.error('[whale-shim] session/disposed error:', err)
      }
    }
  }

  function dispose() {
    for (const d of disposers) {
      try { d() } catch { /* ignore */ }
    }
    disposers.length = 0
    if (server) {
      try { server.close() } catch { /* ignore */ }
      server = null
    }
  }

  return {
    start,
    loadPlugin,
    emitSessionEvent,
    emitSessionDisposed,
    dispose,
    getContext: () => ctx,
    getPort: () => port,
    getDataDir: () => dataDir,
  }
}
