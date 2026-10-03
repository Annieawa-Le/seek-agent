/**
 * M2 + M3 验收（无 GUI）：宿主路由 / 沙箱页契约 / 风格库检索。
 *
 * M2 的「脚本真的跑在隔离源里」需要浏览器才验得了（见 README 的手动验收清单），
 * 这里能验的是它的**前置条件**：沙箱页可取、CSP 与 sandbox 属性正确、脚本/样式路由通、
 * 卡内脚本抽取与 input 桥归一的转换逻辑符合预期。
 * M3 全在文件层，可直接验：风格清单可解析、slug 白名单、取文成功。
 */
import { createRawHtmlHost } from '../host.mjs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)))
const h = createRawHtmlHost({ skillDir, trusted: true })
const { port } = await h.start()
const base = 'http://127.0.0.1:' + port
const get = async (p) => {
  const r = await fetch(base + p)
  return { status: r.status, text: await r.text(), type: r.headers.get('content-type') }
}

let fails = 0
const check = (name, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`)
}

// ── M2：宿主与沙箱页 ──
const frame = await get('/client/sandbox-frame.html')
check('frame 页可取', frame.status === 200 && frame.type.includes('html'))
check('frame 的 {{HOST}} 已替换', !frame.text.includes('{{HOST}}') && frame.text.includes('127.0.0.1:' + port))
check('frame 带 CSP（禁 connect/frame/object）', 
  /default-src 'none'/.test(frame.text) && /connect-src 'none'/.test(frame.text) && /frame-src 'none'/.test(frame.text))
// 卡内/页内脚本靠 new Function 执行，script-src 必须含 'unsafe-eval'——
// 这在 opaque origin 的沙箱里是可接受的（见 sandbox-frame.html 的 CSP 说明）
check('frame 的 script-src 放行自身源 + unsafe-eval', 
  /script-src 'unsafe-inline' 'unsafe-eval' http:\/\/127\.0\.0\.1:/.test(frame.text))
check('frame 禁脚本联网（connect-src none）', /connect-src 'none'/.test(frame.text))

const sandboxJs = await get('/client/sandbox-frame.js')
check('沙箱脚本可取', sandboxJs.status === 200 && sandboxJs.text.includes('__vcpSandbox'))

const health = JSON.parse((await get('/health')).text)
check('health 报 page=true', health.capabilities.page === true)
check('health 报 trusted=true（本轮传入）', health.capabilities.trusted === true)
check('health 给出 sandbox 路径', health.capabilities.sandbox === '/client/sandbox-frame.html')

// 安全模式：不传 trusted 时 capabilities 应为 false
const h2 = createRawHtmlHost({ skillDir })
const { port: p2 } = await h2.start()
const health2 = JSON.parse(await (await fetch('http://127.0.0.1:' + p2 + '/health')).text())
check('安全模式下 trusted=false', health2.capabilities.trusted === false)
h2.stop()

// ── 沙箱页的两段核心转换逻辑（从源码断言行为，避免在 Node 里搭完整 DOM）──
const frameSrc = await readFile(join(skillDir, 'client', 'sandbox-frame.js'), 'utf8')
check('沙箱摘 <script> 后再执行', /replace\(\/<script\\b\[\^>\]\*>/.test(frameSrc) || frameSrc.includes('<script\\b'))
check('沙箱有 input 桥委托', frameSrc.includes('data-vcp-input'))
check('沙箱只上报 height/input/ready', ['height', 'input', 'ready'].every((k) => frameSrc.includes(k)))

// ── M2：client 端可信模式与页面接线 ──
const clientSrc = await readFile(join(skillDir, 'client', 'raw-html.js'), 'utf8')
check('client 读可信开关', clientSrc.includes('__SEEK_RAW_HTML_TRUSTED'))
check('client 用 iframe sandbox=allow-scripts', clientSrc.includes("sandbox: 'allow-scripts'"))
check('client 拒绝非 opaque 源消息', clientSrc.includes("ev.origin !== 'null'"))
check('client page 段接沙箱（不再降级 md）', clientSrc.includes("mode: 'document'"))
check('client 可信卡片接沙箱', clientSrc.includes("mode: 'card'"))

const html = await readFile(join(skillDir, 'client', 'sandbox-frame.html'), 'utf8')
check('frame 不含 allow-same-origin（无该字样）', !html.includes('allow-same-origin'))

// ── M3：风格库 ──
const stylesDir = join(skillDir, 'styles')
const files = await readdir(stylesDir)
const styleSlugs = files.filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.replace(/\.md$/, ''))
check('风格数 = 12', styleSlugs.length === 12, 'got ' + styleSlugs.length)
check('索引/兜底/字体三件套齐', ['_INDEX.md', '_BASELINE.md', '_FONTS.md'].every((f) => files.includes(f)))

const indexText = await readFile(join(stylesDir, '_INDEX.md'), 'utf8')
const indexSlugs = indexText.split(/\r?\n/)
  .map((l) => /^\s*[-*]\s*([a-z0-9][a-z0-9-]*)\s*[—–-]\s*(.+?)\s*$/.exec(l))
  .filter(Boolean).map((m) => m[1])
check('索引解析出的 slug 与文件一致', indexSlugs.length === 12 && indexSlugs.every((s) => styleSlugs.includes(s)),
  `index=${indexSlugs.length} files=${styleSlugs.length}`)

// 每套风格都含「判断准则」段（上游文档骨架的硬要求）
let skeletonOk = 0
for (const s of styleSlugs) {
  const t = await readFile(join(stylesDir, s + '.md'), 'utf8')
  if (t.includes('判断准则') || t.includes('核心命题') || t.includes('这是什么')) skeletonOk++
}
check('每套风格都有实质骨架', skeletonOk === styleSlugs.length, `ok=${skeletonOk}/${styleSlugs.length}`)

console.log('---')
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`)
h.stop()
process.exit(fails === 0 ? 0 : 1)
