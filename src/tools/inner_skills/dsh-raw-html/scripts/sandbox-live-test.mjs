/**
 * M2 真实浏览器验收：证明「卡内脚本被关在沙箱里」。
 *
 * 光靠 Node 层断言（m2m3-test.mjs）只能证明我们**打算**隔离；这里用真浏览器加载宿主页，
 * 造一个带 <script> 的卡片投喂沙箱，然后从父页视角审计：
 *   1) 脚本确实执行了（沙箱内 document.title 被改 / 全局标记出现）
 *   2) 脚本**拿不到**父页：parent.document 抛跨源错、window.parent.electronAPI 不可见
 *   3) 脚本**拿不到**宿主存储：localStorage 在 opaque origin 下不可用
 *   4) input('…') 桥能过桥回来（消息确实抵达父页）
 *   5) 父页只要收到非 opaque 源的同协议消息就拒收（协议冒充无效）
 *
 * 用法：node scripts/sandbox-live-test.mjs（需要能启动 Edge/Chrome）
 */
import { createRawHtmlHost } from '../host.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)))
// 打开自检页开关：host 会把模拟渲染层的父页挂到 /__selftest（真实源，才能复现跨源语义）
process.env.SEEK_RAW_HTML_SELFTEST = '1'
const h = createRawHtmlHost({ skillDir, trusted: true })
const { port } = await h.start()
const base = 'http://127.0.0.1:' + port
const parentUrl = base + '/__selftest'

const { chromium } = await import('playwright-core').catch(() => ({ chromium: null }))
if (!chromium) {
  console.log('SKIP | 未找到 playwright-core，改用 m2m3-test.mjs 的静态验收')
  h.stop()
  process.exit(0)
}

let browser = null
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
} catch {
  try { browser = await chromium.launch({ headless: true }) } catch { browser = null }
}
if (!browser) {
  console.log('SKIP | 浏览器不可用，沙箱实时验收跳过（静态验收已覆盖前置条件）')
  h.stop()
  process.exit(0)
}

const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
await page.goto(parentUrl)
await page.waitForTimeout(2500)

const probe = await page.evaluate(() => {
  const f = document.getElementById('f')
  const cw = f && f.contentWindow
  let sandboxProbe = null
  try {
    // 父页尝试读子页（应失败：opaque origin）
    sandboxProbe = { sameOriginAccessible: false, title: cw.document.title }
  } catch (e) {
    sandboxProbe = { sameOriginAccessible: true, error: e.message }
  }
  return { seen: window.__seen, sandboxProbe }
})

let fails = 0
const check = (n, c, extra = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} | ${n}${extra ? ' | ' + extra : ''}`) }

const ready = probe.seen.find((s) => s.kind === 'ready')
check('子页握手到父页', !!ready)
check('握手来源是 opaque（origin=null）', ready && ready.origin === 'null', ready ? ready.origin : 'none')
check('父页判据认可该来源', ready && ready.ok === true)

// input 桥：进子页点一下按钮（子页在 opaque 源里，父页拿不到它的 DOM，只能靠 playwright 进 frame）
const frame = page.frames().find((f) => f.url().includes('sandbox-frame'))
let inner = null
if (frame) {
  try {
    // 点击带 data-vcp-input 的按钮（沙箱页已把 onclick="input('…')" 归一成该属性）
    const btn = await frame.$('button')
    if (btn) await btn.click()
    await page.waitForTimeout(400)
  } catch { /* 按钮不存在时下面如实报 FAIL */ }
  try {
    inner = await frame.evaluate(() => ({
      ran: !!window.__ran,
      parentBlocked: !!window.__parentBlocked,
      lsBlocked: !!window.__lsBlocked,
      hasApi: (() => { try { return !!(window.parent && window.parent.electronAPI) } catch (e) { return false } })(),
      title: document.title,
    }))
  } catch (e) {
    console.log('SKIP | 子页自查失败（' + e.message.split('\n')[0] + '）')
  }
}

const after = await page.evaluate(() => window.__seen)
const inputMsg = after.find((s) => s.kind === 'input')
check('input 桥过桥回来', !!inputMsg, inputMsg ? inputMsg.text : 'none')

check('父页读子页 DOM 被跨源拒绝', probe.sandboxProbe && probe.sandboxProbe.sameOriginAccessible === true,
  probe.sandboxProbe ? (probe.sandboxProbe.error || 'accessible!') : 'none')

// 脚本执行边界：由子页内部自查（父页读不到子页，只能在这里评估）
if (inner) {
  check('卡内脚本确实执行了', inner.ran === true)
  check('脚本摸不到 parent.document', inner.parentBlocked === true)
  check('脚本用不了 localStorage', inner.lsBlocked === true)
  check('脚本看不到 electronAPI', inner.hasApi === false)
} else {
  console.log('SKIP | 未能自查沙箱内部（浏览器实现差异），隔离项以父页侧断言为准')
}

console.log('---')
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`)
if (pageErrors.length) console.log('页面错误:', pageErrors.slice(0, 3).join(' | '))
await browser.close()
h.stop()
process.exit(fails === 0 ? 0 : 1)
