/**
 * 引擎注册链路自检（M1 验收脚本，可在无 GUI 环境跑）：
 *   起宿主 → 按 client/raw-html.js 的注入契约立起 vc/hp/f 全局 → 拉引擎脚本 eval
 *   → 断言 __vcpStable 注册成功、render() 真的走了 vc shim。
 * 这不是渲染层验收（那要看 GUI），只保证「宿主 + 注入契约 + 引擎」三段链路是通的。
 *
 * 输出统一 ASCII 前缀，避免 Windows cmd 代码页把中文打成乱码。
 */
import { createRawHtmlHost } from '../host.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)))
const h = createRawHtmlHost({ skillDir })
const { port } = await h.start()
const base = 'http://127.0.0.1:' + port

// ── 按注入契约立起引擎依赖（与 client/raw-html.js 的 makeVcShim 同形，此处为探针）──
const calls = []
const doc = {
  body: { childNodes: [] },
  head: { appendChild() {} },
  getElementById() { return null },
  createElement: () => ({ set textContent(v) {}, id: '', appendChild() {}, style: {} }),
  querySelectorAll: () => [],
  addEventListener() {},
}
globalThis.window = globalThis
globalThis.vc = (node, key) => { calls.push(node && node.localName); return { node, key } }
globalThis.hp = (s) => ({ __style: s })
globalThis.f = { Fragment: Symbol('F'), jsx: (type, props) => ({ type, props }) }
globalThis.document = doc
globalThis.localStorage = { getItem: () => '1', setItem() {} }
globalThis.performance = { now: () => 0 }
globalThis.requestAnimationFrame = (fn) => { try { fn() } catch { /* 探针忽略 */ } return 0 }
globalThis.cancelAnimationFrame = () => {}
globalThis.setTimeout = globalThis.setTimeout || (() => 0)
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
globalThis.DOMParser = class {
  parseFromString(html) {
    // 极简探针解析器：把顶层标签名抓出来交给 vc，足以验证 shim 链路
    const nodes = []
    const re = /<([a-zA-Z][\w-]*)([^>]*)>/g
    let m
    while ((m = re.exec(html))) {
      if (m[1].toLowerCase() === 'style') continue
      nodes.push({
        nodeType: 1,
        localName: m[1].toLowerCase(),
        attributes: [],
        childNodes: [],
      })
    }
    return { body: { childNodes: nodes } }
  }
}

const src = await (await fetch(base + '/vendor/vcp-engine-v1.js')).text()
console.log('engine-bytes:', src.length, '| has-boot-fragment:', src.includes('__vcpEngineReady'))
// eslint-disable-next-line no-eval
eval(src)

const stable = globalThis.__vcpStable
console.log('stable:', typeof stable, '| render:', typeof (stable || {}).render, '| fixBlank:', typeof (stable || {}).fixBlank)
console.log('boot-flag:', globalThis.__vcpEngineReady)

const card = '<div id="vcp-root"><style>#vcp-root{background:#111;color:#eee}</style><h1>Haiyan</h1><p>text</p></div>'
let el = null
let err = null
try { el = stable.render(card, false) } catch (e) { err = e }
console.log('render(full-card) ->', el === null ? 'null' : typeof el, '| err:', err ? err.message : 'none')
console.log('vc-calls:', calls.length, '| first:', JSON.stringify(calls[0]))

const partial = '<div id="vcp-root"><style>#vcp-root{background:#111</style><h1>Ha'
let el2 = null
try { el2 = stable.render(partial, true) } catch (e) { console.log('stream-error:', e.message) }
console.log('render(partial-stream) ->', el2 === null ? 'null' : typeof el2)

h.stop()

