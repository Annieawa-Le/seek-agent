/**
 * dsh-raw-html 宿主半区 —— 由 Electron 主进程动态 import 托管（本文件是 inner_skill 的「宿主那一半」）。
 *
 * 与上游（DSH Cordis 插件）的差别：
 *   上游由 DSH 宿主提供 /vendor /fonts 路由 + loopback RPC（字体扫描、系统目录选择）；
 *   这里宿主缩到最小——**只做静态资源托管**，不持有任何会话/文件能力（前端注入后直接用
 *   window.electronAPI）。上游的 fontsRoot / 外置大字体库 / 风格库 RPC 均未移植。
 *
 * 提供：
 *   GET /health            健康检查（版本 + 能力清单），供主进程/调试自检
 *   GET /client/raw-html.js    前端脚本（由 main.js 注入渲染层执行）
 *   GET /fonts.css         内置字体的 @font-face 样式表（url() 相对本服务解析）
 *   GET /fonts/<file>      字体文件（白名单：assets/fonts 目录内）
 *   GET /vendor/<file>     引擎 / KaTeX / Mermaid / 色引擎（白名单：assets/vendor 目录内）
 *
 * 引擎响应特例：/vendor/vcp-engine-v1.js 尾部追加 client/engine-boot.js —— 等价于上游
 * 用 new Function('vc','hp','f', src) 注入依赖（详见该片段头部注释）。
 *
 * 依赖：node:http + node:fs，零第三方依赖。
 * 卸载：删掉本目录即可，主进程动态 import 失败会被捕获，不影响主功能。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep, extname } from 'node:path'

export const RAW_HTML_VERSION = '0.1.0'

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

/** 内置字体 → @font-face 声明（字体名与上游 Lanxi-* 系列保持一致，写卡时直接引用） */
const FONT_FACES = [
  { file: 'Lanxi-HeiTi.woff2', family: 'Lanxi-HeiTi', weight: 400 },
  { file: 'Lanxi-HeiTiLight.woff2', family: 'Lanxi-HeiTiLight', weight: 400 },
  { file: 'Lanxi-HeiTiBold.woff2', family: 'Lanxi-HeiTiBold', weight: 400 },
  { file: 'Lanxi-WenKai.woff2', family: 'Lanxi-WenKai', weight: 400 },
  { file: 'Lanxi-MaShanZheng.woff2', family: 'Lanxi-MaShanZheng', weight: 400 },
  { file: 'Lanxi-GreatVibes.woff2', family: 'Lanxi-GreatVibes', weight: 400 },
]

/**
 * 自检页（仅 SEEK_RAW_HTML_SELFTEST=1 时挂到 /__selftest）：模拟渲染层的父页——
 * 挂沙箱 iframe、按协议投喂带脚本的卡片、收集子页上报。用真实 http 源承载，
 * 才能如实复现「file:// 渲染层 ↔ opaque 沙箱」的跨源语义。
 */
const SELF_TEST_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>selftest-parent</title></head><body>
<script>
window.__seen = [];
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (!d || typeof d !== 'object' || !d.__vcpSandbox) return;
  // 渲染层的判据：不接受非 opaque 源
  window.__seen.push({ ok: ev.origin === 'null', origin: String(ev.origin), kind: d.__vcpSandbox, text: d.text || '' });
  if (d.__vcpSandbox === 'ready') {
    var f = document.getElementById('f');
    var S = '<' + 'script>';
    var E = '<' + '/script>';
    var card = '<div id="vcp-root"><h1 id="t">card</h1>'
      + '<button onclick="input(\\'hi from card\\')">go</button>'
      + S + 'window.__ran=1;'
      + 'try{parent.document.title="x"}catch(e){window.__parentBlocked=1}'
      + 'try{localStorage.setItem("x","1");window.__lsOk=1}catch(e){window.__lsBlocked=1}'
      + 'try{window.__hasApi=!!(parent.electronAPI)}catch(e){window.__hasApi=false}'
      + E + '</div>';
    f.contentWindow.postMessage({ __vcpSandbox: 'card', html: card, css: '' }, '*');
  }
});
</script>
<iframe id="f" src="{{HOST}}/client/sandbox-frame.html" sandbox="allow-scripts" style="width:420px;height:220px"></iframe>
</body></html>`

/**
 * @param {{ skillDir: string, trusted?: boolean }} opts
 *   skillDir = 本插件目录（宿主按此解析 client/ 与 assets/）
 *   trusted  = 可信模式：卡内 <script> 在 iframe 沙箱内执行（默认关；关时脚本被丢弃且不执行）
 */
export function createRawHtmlHost({ skillDir, trusted = false }) {
  const clientDir = join(skillDir, 'client')
  const fontsDir = join(skillDir, 'assets', 'fonts')
  const vendorDir = join(skillDir, 'assets', 'vendor')
  const vendorEntries = new Set()
  const fontEntries = new Set(FONT_FACES.map((f) => f.file))

  let server = null
  let port = 0

  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(body)
  }
  const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), MIME['.json'])

  /** 目录白名单读取（防目录穿越）：只允许 baseDir 内的相对路径 */
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

  /** 字体样式表：url() 用相对路径，浏览器按样式表所在地址（本服务）解析 */
  function buildFontsCss() {
    return FONT_FACES.map((f) => {
      const src = `/fonts/${encodeURIComponent(f.file)}`
      return [
        `@font-face{`,
        `font-family:'${f.family}';`,
        `src:url('${src}') format('woff2');`,
        `font-weight:${f.weight};font-style:normal;font-display:swap;`,
        `}`,
      ].join('')
    }).join('\n') + '\n'
  }

  async function handler(req, res) {
    // file:// 页面 → http://127.0.0.1 属于跨源，放开 CORS（主进程另有请求头改写）
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
      return json(res, {
        ok: true,
        plugin: 'dsh-raw-html',
        version: RAW_HTML_VERSION,
        capabilities: {
          card: true,          // vcp-root 卡片（HTML/CSS/SVG）
          markdown: true,      // 非卡段落交回渲染层 markdown
          math: true,          // KaTeX（$$…$$ / $…$）
          mermaid: true,       // ```mermaid 围栏 → 图表
          fonts: FONT_FACES.length,
          page: true,          // 整页程序页（iframe 沙箱内渲染，脚本隔离）
          trusted: !!trusted,  // 可信卡片（卡内脚本在沙箱内执行，非主文档）
          sandbox: '/client/sandbox-frame.html',
        },
      })
    }

    if (pathname === '/fonts.css') {
      return send(res, 200, buildFontsCss(), MIME['.css'])
    }

    // 自检页：仅测试用（把父页放在真实源上，才能如实复现渲染层↔沙箱的跨源语义）。
    // 生产渲染层不会走到这里——它由 Electron 以 file:// 加载、插件前端注入执行。
    if (pathname === '/__selftest' && process.env.SEEK_RAW_HTML_SELFTEST === '1') {
      return send(res, 200, SELF_TEST_HTML.replace(/\{\{HOST\}\}/g, `http://127.0.0.1:${port}`), MIME['.html'])
    }

    if (pathname.startsWith('/fonts/')) {
      const rel = pathname.slice('/fonts/'.length)
      if (!fontEntries.has(rel)) return send(res, 404, 'not found')
      return serveFrom(res, fontsDir, rel)
    }

    if (pathname.startsWith('/client/')) {
      const rel = pathname.slice('/client/'.length)
      // 沙箱页需把 {{HOST}} 占位换成真实源（CSP 与脚本 src 都不能写死端口）
      if (rel === 'sandbox-frame.html') {
        try {
          const html = await readFile(join(clientDir, rel), 'utf8')
          const origin = `http://127.0.0.1:${port}`
          return send(res, 200, html.split('{{HOST}}').join(origin), MIME['.html'])
        } catch {
          return send(res, 500, 'frame read error')
        }
      }
      return serveFrom(res, clientDir, rel)
    }

    if (pathname.startsWith('/vendor/')) {
      const rel = pathname.slice('/vendor/'.length)
      // 引擎本体允许（下方追加自注册片段）；其余仅限 assets/vendor 实存文件
      if (rel === 'vcp-engine-v1.js') {
        try {
          const src = await readFile(join(vendorDir, rel), 'utf8')
          const boot = await readFile(join(clientDir, 'engine-boot.js'), 'utf8')
          return send(res, 200, src + '\n' + boot, MIME['.js'])
        } catch {
          return send(res, 500, 'engine read error')
        }
      }
      if (vendorEntries.has(rel)) return serveFrom(res, vendorDir, rel)
      return serveFrom(res, vendorDir, rel)
    }

    return send(res, 404, 'not found')
  }

  return {
    async start() {
      // 预扫 vendor 目录（仅用于白名单提示，实际读取仍走路径校验）
      try {
        const { readdir } = await import('node:fs/promises')
        for (const name of await readdir(vendorDir)) vendorEntries.add(name)
        const sub = join(vendorDir, 'fonts')
        if (existsSync(sub)) {
          const { readdir: rd } = await import('node:fs/promises')
          for (const name of await rd(sub)) vendorEntries.add('fonts/' + name)
        }
      } catch {
        /* 目录缺失按空处理 */
      }
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

