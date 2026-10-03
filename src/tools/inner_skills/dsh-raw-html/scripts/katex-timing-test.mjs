/**
 * 回归：卡片 KaTeX 渲染的时序鲁棒性
 *
 * 覆盖的真实场景：
 *   A. KaTeX 已就绪 → 卡片渲染即出公式
 *   B. KaTeX 迟到（卡片先挂）→ MathPass 的 useEffect + 重试补渲染
 *   C. 流式卡片（streaming=true）→ 停顿后仍能渲染
 *
 * 依赖真实浏览器（React + 真实引擎 + 真实 KaTeX），用 playwright-core 驱动。
 */
import { createRawHtmlHost } from '../host.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)))
const host = createRawHtmlHost({ skillDir, trusted: false })
const { port } = await host.start()
const HOST = `http://127.0.0.1:${port}`

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// 复用系统 Edge
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
await page.goto(`${HOST}/health`, { waitUntil: 'load' })

// 在页内准备：React + 扩展点 + 注入插件
await page.evaluate(async (HOST) => {
  const load = (src) => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src
    s.onload = res; s.onerror = rej; document.head.appendChild(s)
  })
  await load('https://unpkg.com/react@18/umd/react.production.min.js')
  await load('https://unpkg.com/react-dom@18/umd/react-dom.production.min.js')
  window.__renderers = []
  window.__SEEK_CONTENT_EXTENSION = {
    register: (fn) => { window.__renderers.push(fn); return () => {} },
    unregister: () => {}, react: window.React,
    renderMarkdown: (t) => `<p>${t}</p>`,
  }
  window.__SEEK_EXT_HOST = HOST
  window.__SEEK_RAW_HTML_TRUSTED = false
  // 复刻 electron/main.js 的 injection prelude：从扩展点取 React 挂到 __seekReact
  window.__seekReact = window.__SEEK_CONTENT_EXTENSION.react
  const code = await (await fetch(HOST + '/client/raw-html.js')).text()
  new Function(code).call(window)
}, HOST)

// ── A. KaTeX 已就绪 ──
console.log('\nA. KaTeX 就绪时渲染卡片')
await page.waitForFunction(() => typeof window.renderMathInElement === 'function' && !!window.__vcpEngineReady, { timeout: 20000 })
const a = await page.evaluate(async () => {
  const el = document.createElement('div'); el.id = 'a'; document.body.appendChild(el)
  const card = '<div id="vcp-root"><div>$$E = mc^2$$</div></div>'
  const out = window.__renderers[0](card, { streaming: false, key: 'a1' })
  window.ReactDOM.createRoot(el).render(out)
  await new Promise((r) => setTimeout(r, 1200))
  return document.querySelectorAll('#a .katex').length
})
check('块级公式渲染为 .katex', a >= 1, `(得到 ${a})`)

// ── B. KaTeX 迟到 ──
console.log('\nB. KaTeX 迟到（卡片先挂载）')
const b = await page.evaluate(async () => {
  delete window.renderMathInElement; delete window.katex
  document.body.innerHTML = ''
  window.__dshRawHtmlUnmount && window.__dshRawHtmlUnmount()
  window.__dshRawHtmlLoaded = false
  window.__renderers = []
  window.__seekReact = window.React
  const code = await (await fetch(window.__SEEK_EXT_HOST + '/client/raw-html.js')).text()
  new Function(code).call(window)
  await new Promise((r) => setTimeout(r, 400))

  const el = document.createElement('div'); el.id = 'b'; document.body.appendChild(el)
  const card = '<div id="vcp-root"><div>$$\\int_0^\\infty e^{-x}dx = 1$$</div></div>'
  const out = window.__renderers[0](card, { streaming: false, key: 'b1' })
  window.ReactDOM.createRoot(el).render(out)
  await new Promise((r) => setTimeout(r, 300))
  const before = document.querySelectorAll('#b .katex').length

  // KaTeX 现在才到达
  const load = (src) => new Promise((res) => {
    const s = document.createElement('script'); s.src = src
    s.onload = res; s.onerror = res; document.head.appendChild(s)
  })
  const link = document.createElement('link')
  link.rel = 'stylesheet'; link.href = window.__SEEK_EXT_HOST + '/vendor/katex-vd.css'
  document.head.appendChild(link)
  await load(window.__SEEK_EXT_HOST + '/vendor/katex.min.js')
  await load(window.__SEEK_EXT_HOST + '/vendor/auto-render.min.js')

  await new Promise((r) => setTimeout(r, 1600))
  return { before, after: document.querySelectorAll('#b .katex').length }
})
check('KaTeX 到达前未渲染', b.before === 0, `(得到 ${b.before})`)
check('KaTeX 到达后自动补渲染', b.after >= 1, `(得到 ${b.after})`)

// ── C. 流式卡片 ──
console.log('\nC. 流式卡片结束后的公式')
const c = await page.evaluate(async () => {
  document.body.innerHTML = ''
  const el = document.createElement('div'); el.id = 'c'; document.body.appendChild(el)
  const partial = '<div id="vcp-root"><div>$$a^2+b^2=c^2$$</div>'
  const out1 = window.__renderers[0](partial, { streaming: true, key: 'c1' })
  const root = window.ReactDOM.createRoot(el)
  root.render(out1)
  await new Promise((r) => setTimeout(r, 400))
  // 流式结束（闭合标签）
  const full = '<div id="vcp-root"><div>$$a^2+b^2=c^2$$</div></div>'
  const out2 = window.__renderers[0](full, { streaming: false, key: 'c1' })
  root.render(out2)
  await new Promise((r) => setTimeout(r, 1200))
  return document.querySelectorAll('#c .katex').length
})
check('流式结束后公式渲染', c >= 1, `(得到 ${c})`)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
await browser.close()
host.stop()
process.exit(fail === 0 ? 0 : 1)
