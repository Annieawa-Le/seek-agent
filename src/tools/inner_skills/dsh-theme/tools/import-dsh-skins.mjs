#!/usr/bin/env node
/**
 * dsh-theme 皮肤导入器 —— 把 DSH（DeepSeek Harness）web 客户端皮肤包转成
 * 本插件认的皮肤包格式。
 *
 * 上游皮肤包形态（dsh-web-ui / EAC 内置系列）：
 *   skin.json        元信息（id / name / bodyAttr / tags / preview …）
 *   package.json     包名与版本
 *   lib/client.js    window.__ModuleLoader__.load({ id, factory }) bundle：
 *                    factory 体内是「一段 CSS 字符串 + 一段纯 DOM 的 apply(ctx) 装饰逻辑」
 *
 * 本插件认的形态（themes/<id>/）：
 *   skin.json  同名字段，另加 css / script / scope
 *   skin.css   上游 bundle 里的 CSS 字符串（原样，供加载器注入）
 *   skin.js    上游 factory 体（原样），末尾接一个适配层把 exports.apply 导成 ESM
 *
 * 转换是机械的：皮肤脚本一行未改，CSS 一字未动。DSH 与 seek-agent 的结构差异
 * （根节点 id、data-pane、令牌）由加载器与转义层在运行时兜底，不在这里硬改皮肤。
 *
 * 用法：
 *   node tools/import-dsh-skins.mjs <源目录> [皮肤 id...]
 *   node tools/import-dsh-skins.mjs <源目录> --verify
 *     <源目录> 下每个子目录应含 skin.json + lib/client.js
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const THEMES_DIR = path.join(HERE, '..', 'themes')

/** 从 bundle 文本里抓出 `const css = "..."` 字面量并解码。 */
function extractCss(src) {
  const m = src.match(/const\s+css\s*=\s*("(?:[^"\\]|\\.)*")\s*;/)
  if (!m) return null
  return JSON.parse(m[1])
}

/**
 * 把 __ModuleLoader__ bundle 折成 ESM 皮肤脚本。
 *   · 首部 `window.__ModuleLoader__.load({ id: …, factory: (require) => {` → `const factory = (require) => {`
 *   · css 字面量清空（样式已抽到 skin.css，bundle 里那段注入逻辑留下一枚空 style，无害）
 *   · 尾部 `}  });` → `};` + 适配层
 */
function toEsmScript(src) {
  let out = src
  const head = out.match(/window\.__ModuleLoader__\.load\(\{[\s\S]*?factory:\s*\(require\)\s*=>\s*\{/)
  if (!head) throw new Error('未找到 __ModuleLoader__ bundle 首部')
  out = out.replace(head[0], 'const factory = (require) => {')

  // 样式抽走：留着字面量会让 skin.js 里多一份几十 KB 的重复 CSS
  out = out.replace(/const\s+css\s*=\s*"(?:[^"\\]|\\.)*"\s*;/, 'const css = ""; /* 样式已抽出到 skin.css */')

  // 收口：工厂函数闭合 + 导出的适配层
  const tail = out.match(/\n[ \t]*return module\.exports;\n[ \t]*\}\n\}\);/)
  if (!tail) throw new Error('未找到 __ModuleLoader__ bundle 尾部')
  out = out.replace(tail[0], '\n\t\treturn module.exports;\n\t};')

  // 源映射指向的 client.js.map 并不随包分发，去掉免报 404
  out = out.replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, '\n')

  out += `
// ── dsh-theme 适配层 ─────────────────────────────────────────────
// 上游包是 DSH 的 window.__ModuleLoader__ bundle；这里把 factory 跑一遍取它的
// exports.apply —— 皮肤脚本本身一行未改（上面整段 factory 即上游原文）。
const __skinExports = factory(() => {
	throw new Error('皮肤包无外部依赖，require 不应被调用');
});
export const apply = __skinExports.apply;
export const inject = __skinExports.inject;
export default apply;
`
  return out
}

/** 从 CSS 里读首条令牌值，给设置面板的调色板预览用（读不到就留空）。 */
function readToken(css, name) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;\\n]+);`))
  return m ? m[1].trim() : ''
}

/** 读上游 skin.json / package.json，组装本插件格式的 skin.json。 */
function buildSkinJson(id, upstream, pkg, css) {
  const bodyAttr = upstream.bodyAttr || `data-dsh-${id}`
  const palette = {
    background: readToken(css, 'dsw-alias-bg-base'),
    panel: readToken(css, 'dsw-alias-bg-layer-2'),
    text: readToken(css, 'dsw-alias-label-primary'),
    accent: upstream.accent || readToken(css, 'dsw-alias-state-business-primary'),
  }
  const meta = {
    id,
    name: upstream.name || id,
    nameEn: upstream.nameEn || '',
    version: pkg.version || '',
    description: upstream.description || '',
    author: upstream.author || '',
    license: pkg.license || '',
    source: `DSH-Desktop-EAC dsh-desktop/assets/skins/${id} · 上游包 ${pkg.name || ''}`,
    tags: Array.isArray(upstream.tags) ? upstream.tags : [],
    palette,
    css: 'skin.css',
    script: 'skin.js',
    scope: {
      owner: upstream.wiring?.id || id,
      bodyAttribute: bodyAttr,
    },
    upstream: {
      package: pkg.name || '',
      wiringId: upstream.wiring?.id || '',
      repository: pkg.repository?.url || '',
    },
  }
  return meta
}

async function convertOne(srcRoot, id, { verify }) {
  const dir = path.join(srcRoot, id)
  const bundlePath = path.join(dir, 'lib', 'client.js')
  const skinPath = path.join(dir, 'skin.json')
  const pkgPath = path.join(dir, 'package.json')
  if (!existsSync(bundlePath)) throw new Error(`${id}: 缺少 lib/client.js`)
  if (!existsSync(skinPath)) throw new Error(`${id}: 缺少 skin.json`)

  const bundle = await readFile(bundlePath, 'utf8')
  const upstream = JSON.parse(await readFile(skinPath, 'utf8'))
  const pkg = existsSync(pkgPath) ? JSON.parse(await readFile(pkgPath, 'utf8')) : {}

  const css = extractCss(bundle)
  if (!css) throw new Error(`${id}: bundle 里没有 css 字面量`)
  const script = toEsmScript(bundle)

  const outDir = path.join(THEMES_DIR, id)
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'skin.css'), css)
  await writeFile(path.join(outDir, 'skin.js'), script)
  await writeFile(
    path.join(outDir, 'skin.json'),
    JSON.stringify(buildSkinJson(id, upstream, pkg, css), null, 2) + '\n',
  )

  if (verify) {
    // 真跑一遍：语法错、顶层抛错、没导出 apply，都在这里现形
    const mod = await import(pathToFileURL(path.join(outDir, 'skin.js')).href)
    if (typeof mod.apply !== 'function') throw new Error(`${id}: skin.js 未导出 apply`)
  }

  return { id, css: css.length, script: script.length }
}

async function main() {
  const argv = process.argv.slice(2)
  const verify = argv.includes('--verify')
  const positional = argv.filter((a) => !a.startsWith('--'))
  const srcRoot = positional[0]
  if (!srcRoot) {
    console.error('用法：node tools/import-dsh-skins.mjs <源目录> [皮肤 id...] [--verify]')
    process.exit(2)
  }
  let ids = positional.slice(1)
  if (ids.length === 0) {
    const entries = await readdir(srcRoot, { withFileTypes: true })
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  }

  const rows = []
  for (const id of ids) {
    try {
      rows.push(await convertOne(srcRoot, id, { verify }))
    } catch (err) {
      console.error(`✗ ${id}: ${err.message}`)
      process.exitCode = 1
    }
  }
  for (const r of rows) console.log(`✓ ${r.id}: skin.css ${r.css}B · skin.js ${r.script}B`)
  console.log(`\n共转换 ${rows.length} 款 → ${THEMES_DIR}`)
}

main().catch((err) => {
  console.error('转换失败：', err)
  process.exit(1)
})
