// 开发/审计辅助：把 dsh-theme 的宿主半区单独跑起来（浏览器里的审核页面据此取皮肤包）。
// 用法：node tools/dev-host.mjs
import { createDshThemeHost } from '../host.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = createDshThemeHost({ skillDir: SKILL_DIR })
const { port } = await host.start()
const skins = await host.listSkins()
console.log(JSON.stringify({ port, skins: skins.map((s) => s.id) }))
setInterval(() => {}, 1 << 30)
