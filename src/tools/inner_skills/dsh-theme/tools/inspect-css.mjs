// 皮肤 CSS 速查 —— 按关键字打印命中的规则（选择器 + 声明体），定位层叠 / 定位 / 尺寸问题。
// 用法：node tools/inspect-css.mjs <skinId> <关键字...>      （关键字之间是 AND，支持正则）
//   node tools/inspect-css.mjs maid-atelier z-index sidebar
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [id, ...keys] = process.argv.slice(2)
if (!id || keys.length === 0) {
  console.error('用法：node tools/inspect-css.mjs <skinId> <关键字...>')
  process.exit(1)
}
const css = fs.readFileSync(path.join(SKILL_DIR, 'themes', id, 'skin.css'), 'utf8')
const tests = keys.map((k) => new RegExp(k, 'i'))

const RE = /([^{}]+)\{([^{}]*)\}/g
let m
let n = 0
while ((m = RE.exec(css))) {
  const sel = m[1].trim()
  const body = m[2].trim()
  const hay = `${sel} ${body}`
  if (!tests.every((t) => t.test(hay))) continue
  n += 1
  console.log(`--- [${n}] ${sel.length > 320 ? '…' + sel.slice(-320) : sel}`)
  console.log(`    ${body.length > 1500 ? body.slice(0, 1500) + '…' : body}`)
}
console.log(`\n共 ${n} 条`)
