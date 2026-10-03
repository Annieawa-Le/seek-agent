/**
 * dsh-theme 回归测试 —— 皮肤加载器的核心逻辑。
 *
 * 覆盖三块最容易悄悄坏掉的地方：
 *   1. 宿主扫描与托管（host.mjs）：皮肤包发现、路径穿越防护、MIME
 *   2. 资源路径改写：皮肤 CSS 里的相对 url() 必须指到宿主绝对地址
 *   3. 转义层映射表完整性：每条 DSH 契约锚点都有对应落点，且不含高危短名
 *
 * 前端脚本（escape-layer / tokens / theme-loader）跑在浏览器里，这里用最小 DOM 桩
 * 验证映射表与改写逻辑，不做完整浏览器模拟。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDshThemeHost } from '../src/tools/inner_skills/dsh-theme/host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(ROOT, 'src', 'tools', 'inner_skills', 'dsh-theme')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 抓取本地站点的一个路径，返回 { status, body, type }。 */
function fetchLocal(port: number, p: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = createServer; // 占位，避免 lint 报未使用
    void req
    import('node:http').then(({ get }) => {
      get(`http://127.0.0.1:${port}${p}`, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
            type: String(res.headers['content-type'] || ''),
          }),
        )
      }).on('error', reject)
    })
  })
}

/** 从 escape-layer.js 源码里抽出映射表（避免引入浏览器依赖）。 */
function readEscapeLayerSource(): string {
  return readFileSync(join(SKILL_DIR, 'client', 'escape-layer.js'), 'utf8')
}

async function main() {
  console.log('dsh-theme 皮肤加载器回归\n')

  // ── 1. 目录结构完整性 ──
  console.log('【1】插件结构')
  for (const rel of [
    'enable.json',
    'host.mjs',
    'index.ts',
    'translation.ts',
    'SYSTEM_INJECTION.md',
    'client/theme-loader.js',
    'client/escape-layer.js',
    'client/tokens.js',
    'themes/roxy-celestial-library/skin.json',
    'themes/roxy-celestial-library/skin.css',
    'themes/roxy-celestial-library/skin.js',
  ]) {
    check(`存在 ${rel}`, existsSync(join(SKILL_DIR, rel)))
  }

  // 素材齐备，且**确实是图片**：只看体积会漏掉「把 404 页面存成 .png」这类事故——
  // 九宫格金框于是画不出来，border-image 退化成实心边框，就是一圈大白框。
  const skinDir = join(SKILL_DIR, 'themes', 'roxy-celestial-library')
  const skinMeta = JSON.parse(readFileSync(join(skinDir, 'skin.json'), 'utf8'))
  const headHex = (p: string) => readFileSync(p).subarray(0, 4).toString('hex')
  const isImage = (h: string) => ['52494646', '89504e47', 'ffd8ff'].some((sig) => h.startsWith(sig))
  for (const rel of Object.values(skinMeta.assets || {}) as string[]) {
    const p = join(skinDir, rel)
    const ok = existsSync(p)
    const size = ok ? readFileSync(p).length : 0
    check(`素材 ${rel} 存在且够大（${size} 字节）`, ok && size > 1024, ok ? `仅 ${size} 字节` : '缺失')
    check(`素材 ${rel} 是真图片（魔数）`, ok && isImage(headHex(p)), ok ? `文件头 ${headHex(p)}` : '缺失')
    // RIFF（WebP）自带长度声明：与文件实际长度不符即下载被截断，解码必然失败
    if (ok && headHex(p) === '52494646') {
      const buf = readFileSync(p)
      const declared = buf.readUInt32LE(4) + 8
      check(`素材 ${rel} 未被截断（声明 ${declared} / 实际 ${buf.length}）`, declared === buf.length)
    }
  }
  check('素材键位齐备（4 张）', Object.keys(skinMeta.assets || {}).length === 4)

  // ── 2. 宿主半区 ──
  console.log('\n【2】宿主半区（host.mjs）')
  const host = createDshThemeHost({ skillDir: SKILL_DIR, autoActivate: 'roxy-celestial-library' })
  const { port } = await host.start()

  const health = await fetchLocal(port, '/health')
  check('GET /health 返回 200', health.status === 200)
  const healthJson = JSON.parse(health.body)
  check('健康检查报出插件名', healthJson.plugin === 'dsh-theme', healthJson.plugin)
  check('健康检查报出皮肤数', healthJson.capabilities.skins >= 1, String(healthJson.capabilities.skins))

  const skinsRes = await fetchLocal(port, '/skins')
  const skinsJson = JSON.parse(skinsRes.body)
  check('GET /skins 返回皮肤清单', Array.isArray(skinsJson.skins) && skinsJson.skins.length >= 1)
  const roxy = skinsJson.skins.find((s: { id: string }) => s.id === 'roxy-celestial-library')
  check('清单含 roxy 皮肤', !!roxy)
  check('清单带调色板', !!roxy?.palette?.ice, JSON.stringify(roxy?.palette))
  // 单色皮肤要在清单里报出配色，设置面板据此提示「亮暗被锁定」
  check('清单带固定配色声明', roxy?.colorScheme === 'dark', String(roxy?.colorScheme))

  const meta = await fetchLocal(port, '/skins/roxy-celestial-library/skin.json')
  check('取回 skin.json', meta.status === 200 && meta.body.includes('roxy-celestial-library'))

  const cssRes = await fetchLocal(port, '/skins/roxy-celestial-library/skin.css')
  check('取回 skin.css', cssRes.status === 200 && cssRes.type.includes('text/css'), cssRes.type)

  const assetRes = await fetchLocal(port, '/skins/roxy-celestial-library/assets/bg.webp')
  check('取回素材（webp MIME）', assetRes.status === 200 && assetRes.type.includes('webp'), assetRes.type)

  const loaderRes = await fetchLocal(port, '/client/theme-loader.js')
  check('取回前端加载器', loaderRes.status === 200 && loaderRes.type.includes('javascript'))

  // 路径穿越防护
  const escape1 = await fetchLocal(port, '/skins/roxy-celestial-library/../../../package.json')
  check('拒绝目录穿越（.. 逃逸）', escape1.status === 403 || escape1.status === 404, String(escape1.status))
  const escape2 = await fetchLocal(port, '/client/../../../../etc/passwd')
  check('拒绝 client 目录穿越', escape2.status === 403 || escape2.status === 404, String(escape2.status))

  const missing = await fetchLocal(port, '/skins/roxy-celestial-library/nope.css')
  check('缺失文件返回 404', missing.status === 404)

  host.stop()

  // ── 3. 资源路径改写逻辑 ──
  console.log('\n【3】资源路径改写')
  // 复刻 theme-loader 里的 rewriteAssetUrls 规则（该函数依赖 window，此处独立验证规则）
  function rewrite(css: string, id: string): string {
    const prefix = `http://127.0.0.1:9999/skins/${id}/`
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote, url) => {
      const raw = url.trim()
      if (/^(https?:|data:|blob:|#|var\()/i.test(raw)) return whole
      if (raw.startsWith('/')) return whole
      const normalized = raw.replace(/^\.\//, '')
      return `url(${quote}${prefix}${normalized}${quote})`
    })
  }
  check('相对路径被改写', rewrite('a{background:url("./assets/bg.webp")}', 's1').includes('http://127.0.0.1:9999/skins/s1/assets/bg.webp'))
  check('裸路径被改写', rewrite('a{background:url(assets/bg.webp)}', 's1').includes('/skins/s1/assets/bg.webp'))
  check('HTTP 绝对地址保持', rewrite('a{background:url(https://x.com/a.png)}', 's1').includes('https://x.com/a.png'))
  check('data URI 保持', rewrite('a{background:url(data:image/png;base64,AAA)}', 's1').includes('data:image/png'))
  check('CSS 变量保持', rewrite('a{background:url(var(--x))}', 's1').includes('url(var(--x))') || rewrite('a{background:url(var(--x))}', 's1').includes('var(--x)'))
  const multi = rewrite('a{background:url(a.png)}b{background:url(./b.png)}', 's2')
  check('多处替换都生效', multi.includes('/skins/s2/a.png') && multi.includes('/skins/s2/b.png'))

  // ── 3.5 宿主地址解析（与视觉卡片宿主串扰的回归）──
  console.log('\n【3.5】宿主地址解析')
  // 复现场景：__SEEK_EXT_HOST 是挂件共用的槽，视觉卡片宿主晚一步注入就把它顶成自己的端口。
  // 加载器必须只认插件专属的 __SEEK_THEME_HOST，否则 /skins 会打到卡片宿主（404 → 清单为空）。
  const decoy = createServer((_req, res) => { res.writeHead(404); res.end('not found') })
  await new Promise<void>((r) => decoy.listen(0, '127.0.0.1', () => r()))
  const decoyPort = (decoy.address() as { port: number }).port

  const host2 = createDshThemeHost({ skillDir: SKILL_DIR })
  const { port: themePort } = await host2.start()
  const stub = globalThis as unknown as { window?: Record<string, string> }
  // 两态对照：专属变量有效 + 共享槽已被卡片宿主顶掉
  stub.window = {
    __SEEK_THEME_HOST: `http://127.0.0.1:${themePort}`,
    __SEEK_EXT_HOST: `http://127.0.0.1:${decoyPort}`,
  }

  const loader = await import(pathToFileURL(join(SKILL_DIR, 'client', 'theme-loader.js')).href)
  const listed = (await loader.listSkins()) as Array<{ id: string }>
  check('共享槽被顶掉时仍能列出皮肤（只认专属变量）', listed.length >= 1, `拿到 ${listed.length} 条`)
  check('列到的正是 roxy 皮肤', listed.some((s) => s.id === 'roxy-celestial-library'))

  // 专属变量缺失时回退共享槽（手工注入加载器的老场景）
  stub.window = { __SEEK_EXT_HOST: `http://127.0.0.1:${themePort}` }
  const fallback = (await loader.listSkins()) as Array<{ id: string }>
  check('专属变量缺失时回退共享槽', fallback.length >= 1, `拿到 ${fallback.length} 条`)
  delete stub.window

  // 注入端与消费端必须指向同一个变量名（源码级双保险）
  const loaderSrc = readFileSync(join(SKILL_DIR, 'client', 'theme-loader.js'), 'utf8')
  check('加载器优先读 __SEEK_THEME_HOST', loaderSrc.includes('w.__SEEK_THEME_HOST || w.__SEEK_EXT_HOST'))
  const skinScriptSrc = readFileSync(join(SKILL_DIR, 'themes', 'roxy-celestial-library', 'skin.js'), 'utf8')
  check('皮肤脚本优先读 __SEEK_THEME_HOST', skinScriptSrc.includes('window.__SEEK_THEME_HOST || window.__SEEK_EXT_HOST'))
  host2.stop()
  await new Promise<void>((r) => decoy.close(() => r()))

  // ── 4. 转义层映射表 ──
  console.log('\n【4】转义层映射表')
  const escapeSrc = readEscapeLayerSource()

  // 每条 DSH 契约锚点都应有落点
  for (const anchor of ['_frame', '_sidebarCol', '_centerCol', '_detailsCol', 'data-composer-card', 'data-conversation-scroll', 'data-input-scroll']) {
    check(`锚点 ${anchor} 已映射`, escapeSrc.includes(`'${anchor}'`) || escapeSrc.includes(`"${anchor}"`) || escapeSrc.includes(anchor))
  }
  // DSH 0.2 皮肤把发送钮写作 [class*='primary']：影子类漏了它，那批规则整片落空
  check('锚点 _7tt59G_primary 已映射到发送钮', escapeSrc.includes("['.send-btn', ['_7tt59G_primary']]"))

  // 高危短名（DSH 契约 §8.1）：不得作为「独立影子类」贴出去（带 hash 前缀的完整名是允许的）
  // 抓出所有影子类数组项，逐条判定：恰好等于短名 = 危险；形如 _7tt59G_row = 安全。
  const shadowArrays = [...escapeSrc.matchAll(/\[[^\]]*,\s*\[([^\]]*)\]\s*\]/g)].map((m) => m[1])
  const allClasses = shadowArrays
    .flatMap((arr) => [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]))
  for (const risky of ['_row', '_root', '_column']) {
    const bare = allClasses.filter((c) => c === risky)
    check(`未单独贴高危短名 ${risky}`, bare.length === 0, `发现 ${bare.length} 处`)
  }
  // 反向确认：映射表确实非空（防止上面判定因抓不到数据而假通过）
  check('影子类映射表非空', allClasses.length >= 5, `仅 ${allClasses.length} 条`)

  // 相位判定与折叠态逻辑存在
  check('有相位判定（hero/active）', escapeSrc.includes("'hero'") && escapeSrc.includes("'active'"))
  check('有折叠态镜像', escapeSrc.includes('data-sidebar-collapsed'))
  check('包装层用 display:contents 语义（注释已声明）', escapeSrc.includes('display:contents'))
  // 宿主布局契约：皮肤按 DSH 的「侧栏是真列」写死盒模型，而宿主是抽屉，须由矫正层兜底
  check('有布局矫正层', escapeSrc.includes("LAYOUT_GUARD_ID = 'dsh-theme-layout-guard'"))
  check('矫正侧栏为固定定位（!important）', escapeSrc.includes('position: fixed !important'))
  check('恢复侧栏纵向滚动', escapeSrc.includes('overflow-y: auto !important'))
  check('矫正选择器抬高特异性（三层 id）', escapeSrc.includes('#app #body-row > #left-sidebar'))
  check('decorate 装载矫正层', /export function decorate\(\)[\s\S]*?installLayoutGuard\(\)/.test(escapeSrc))
  check('undecorate 卸下矫正层', /export function undecorate\(\)[\s\S]*?removeLayoutGuard\(\)/.test(escapeSrc))
  check('折叠判据只看 .open 类', escapeSrc.includes("sidebar.classList.contains('open')"))
  check('不再拿窗宽当展开近似', !escapeSrc.includes('window.innerWidth > 900'))
  check('监听侧栏 class 变化', /attributeFilter: \['class'\]/.test(escapeSrc))
  check('皮肤宽度量测同为占位口径', skinScriptSrc.includes("sidebar.classList.contains('open')"))

  // ── 4.5 折叠态布局契约（DOM 桩）──
  console.log('\n【4.5】折叠态布局契约')
  // 折叠态皮肤的全部推导都押在「侧栏占位宽度」上：收起必须为 0，否则皮肤仍按让开一列推导，
  // 场景层从 260px 起铺 → 左边缘空出一条只看得见底色的黑带、消息区被顶到右边。
  // 这里用最小 DOM 桩把该契约钉成行为断言（源码级断言挡不住「写了但没生效」）。
  const mkEl = (width = 260, classes: string[] = []) => {
    const attrs = new Map<string, string>()
    const cls = new Set(classes)
    return {
      textContent: '',
      children: [] as unknown[],
      dataset: {} as Record<string, string>,
      attrs,
      style: {
        setProperty(_k: string, _v: string) {},
        removeProperty(_k: string) {},
      },
      classList: {
        contains: (c: string) => cls.has(c),
        add: (c: string) => { cls.add(c) },
        remove: (c: string) => { cls.delete(c) },
      },
      getAttribute: (n: string) => (attrs.has(n) ? attrs.get(n)! : null),
      setAttribute: (n: string, v: string) => { attrs.set(n, v) },
      removeAttribute: (n: string) => { attrs.delete(n) },
      getBoundingClientRect: () => ({ width, left: 0, right: width }),
      // 侧栏内容容器（installSidebarRoot）要遍历 children、并在列内找固定子节点
      children: [] as unknown[],
      querySelector: () => null,
      appendChild() {},
      prepend() {},
      remove() {},
    }
  }
  const appEl = mkEl()
  const sidebarEl = mkEl()
  const rootEl = mkEl()
  const guardEl = mkEl()
  const cssVars = new Map<string, string>()
  let guardMounted = false
  rootEl.style.setProperty = (k: string, v: string) => { cssVars.set(k, v) }
  guardEl.remove = () => { guardMounted = false }
  const docStub = {
    querySelector: (sel: string) => (sel === '#app' ? appEl : sel === '#left-sidebar' ? sidebarEl : null),
    querySelectorAll: () => [] as unknown[],
    getElementById: (id: string) => (id === 'dsh-theme-layout-guard' && guardMounted ? guardEl : null),
    createElement: () => { guardMounted = true; return guardEl; },
    head: { appendChild() {} },
    documentElement: rootEl,
    body: mkEl(),
  }
  const g = globalThis as unknown as { document?: unknown; window?: unknown }
  g.document = docStub
  g.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} }
  const escape = await import(pathToFileURL(join(SKILL_DIR, 'client', 'escape-layer.js')).href)

  escape.decorate()
  check('收起时占位宽归零', cssVars.get('--dsh-sidebar-width') === '0px', String(cssVars.get('--dsh-sidebar-width')))
  check('收起时 frame 收到折叠信号', appEl.attrs.get('data-sidebar-collapsed') === '')
  check('矫正层已装上', guardMounted && guardEl.textContent.includes('position: fixed !important'))
  sidebarEl.classList.add('open')
  escape.decorate()
  check('展开时写真实占位宽', cssVars.get('--dsh-sidebar-width') === '260px', String(cssVars.get('--dsh-sidebar-width')))
  check('展开时撤掉折叠信号', !appEl.attrs.has('data-sidebar-collapsed'))
  escape.undecorate()
  check('卸载时卸下矫正层', !guardMounted)
  delete g.document
  delete g.window

  // ── 5. 令牌层 ──
  console.log('\n【5】令牌层')
  const tokenSrc = readFileSync(join(SKILL_DIR, 'client', 'tokens.js'), 'utf8')
  for (const tok of ['--dsw-static-neutral-bluish-950', '--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-specific-menu']) {
    check(`令牌 ${tok} 已定义`, tokenSrc.includes(tok))
  }
  for (const compat of ['--dsw-color-bg', '--dsw-color-text', '--dsw-color-primary', '--dsw-color-border']) {
    check(`兼容别名 ${compat} 已提供`, tokenSrc.includes(compat))
  }
  check('主题属性用空串（DSH 契约）', tokenSrc.includes("setAttribute(DARK_ATTRIBUTE, '')"))
  check('暗色属性名正确', tokenSrc.includes("data-ds-dark-theme"))

  // ── 6. 皮肤包内容 ──
  console.log('\n【6】roxy 皮肤包')
  const skinCss = readFileSync(join(SKILL_DIR, 'themes', 'roxy-celestial-library', 'skin.css'), 'utf8')
  const skinJson = JSON.parse(readFileSync(join(SKILL_DIR, 'themes', 'roxy-celestial-library', 'skin.json'), 'utf8'))
  check('皮肤作用域属性已声明', !!skinJson.scope?.bodyAttribute, JSON.stringify(skinJson.scope))
  check('CSS 使用作用域选择器', skinCss.includes(`body[${skinJson.scope.bodyAttribute}='${skinJson.scope.owner}']`))
  check('CSS 含九宫格金框技法', skinCss.includes('border-image-slice'))
  check('CSS 含侧栏金线', skinCss.includes('217, 185, 95'))
  check('CSS 引用皮肤素材变量', skinCss.includes('--roxy-composer-frame-art'))
  // 判定须剔掉注释——皮肤文件头部用 DSH 原始选择器做了锚点对照说明，注释里出现是允许的。
  const skinCssCode = skinCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const leaked = [...skinCssCode.matchAll(/\[class\*=\s*'([^']+)'\]|\.(_[0-9A-Za-z]+_[A-Za-z]+)/g)].map((m) => m[1] || m[2])
  check('CSS 代码部分不含 DSH 私有钩子（应已转义）', leaked.length === 0, `残留：${leaked.join(', ')}`)
  check('skin.js 导出 apply', readFileSync(join(SKILL_DIR, 'themes', 'roxy-celestial-library', 'skin.js'), 'utf8').includes('export function apply'))

  // skin.json 必须声明 script —— 否则加载器跳过 apply()，装饰层（背景/立绘/金框资源）全都不建。
  const skinMeta2 = JSON.parse(readFileSync(join(SKILL_DIR, 'themes', 'roxy-celestial-library', 'skin.json'), 'utf8'))
  check('skin.json 声明了 script', !!skinMeta2.script)
  check('script 指向存在的文件', existsSync(join(SKILL_DIR, 'themes', 'roxy-celestial-library', skinMeta2.script)))
  check('script 声明的文件确实导出 apply',
    readFileSync(join(SKILL_DIR, 'themes', 'roxy-celestial-library', skinMeta2.script), 'utf8').includes('export function apply'))

  // 固定配色声明：皮肤是单色的，加载器据此锁住宿主亮暗（宿主有 70 余条亮色覆写，单色皮肤压不住）
  check('skin.json 声明固定配色', skinMeta2.colorScheme === 'dark', String(skinMeta2.colorScheme))

  // 阅读列宽度只能按容器算：原版拿 100vw 减侧栏推列宽，可宿主右侧栏是活的（栏宽从内容列里扣），
  // 100vw 并不扣 → 窄窗时列伸到右栏底下被裁掉、宽窗又钉死。
  const listRule = /#message-list\s*\{[^}]*\}/.exec(skinCssCode)?.[0] || ''
  check('消息列宽不再用 100vw 硬算', !listRule.includes('100vw'), listRule.replace(/\s+/g, ' '))
  check('消息列宽仍收窄到皮肤阅读列', listRule.includes('max-width: 748px'))
  check('消息列宽不再写死 width', !/(^|[^-])width:/.test(listRule), listRule.replace(/\s+/g, ' '))

  // ── 6.6 EAC / dsh-web-ui 系列皮肤（DSH 0.2 契约）──
  console.log('\n【6.6】EAC 系列皮肤（DSH 0.2 契约）')
  // 这批皮肤来自 EAC 主仓内置的 dsh-web-ui 系列，用的是 DSH 0.2 的 DOM 契约：
  // 根节点写作 [id=root]（宿主是 #app），三列靠 [data-pane=…] 定位。转义层补类名与
  // 属性钩子、加载器在 CSS 文本层补根 id —— 任缺一处，这批皮肤就只落个半身。
  const EAC_SKINS = ['blue-fantasy', 'dragon-heir', 'maid-atelier', 'miku', 'minecraft', 'qq98', 'ths', 'trading', 'whale-song', 'xp']
  const eacLoaderSrc = readFileSync(join(SKILL_DIR, 'client', 'theme-loader.js'), 'utf8')
  check('加载器实现 DSH 根 id 适配', eacLoaderSrc.includes('function adaptDshSelectors'))
  check('根 id 适配在注入前生效', eacLoaderSrc.includes('rewriteAssetUrls(adaptDshSelectors(css), id)'))
  check('加载器也认 #root 的 id 选择器写法', eacLoaderSrc.includes('DSH_ROOT_HASH_RE'))
  check('加载器改写会话列顶栏选择器', eacLoaderSrc.includes('DSH_CONV_HEADER_RE'))
  check('皮肤样式统一提升特异性', eacLoaderSrc.includes('function boostSpecificity'))
  check('特异性提升按顶层逗号拆分（:is 不被拆散）', eacLoaderSrc.includes('function splitSelectorList'))
  check('特异性提升在注入皮肤样式时执行', eacLoaderSrc.includes('boostSpecificity(el)'))
  // 侧栏偏移归零：DSH 的侧栏占位、seek-agent 的侧栏是浮层，皮肤私有的「侧栏宽度」变量要钉成 0
  check('加载器实现侧栏偏移归零', eacLoaderSrc.includes('function neutralizeSidebarOffset'))
  check('侧栏偏移归零排除自有变量', eacLoaderSrc.includes("startsWith('--dsh-')"))
  check('侧栏偏移归零在注入皮肤样式时拼接', eacLoaderSrc.includes('neutralizeSidebarOffset(css, scope.bodyAttribute)'))
  const eacEscapeSrc = readEscapeLayerSource()
  // 侧栏是「列 + 列内内容容器」两层：data-pane=sidebar 贴列本身，列内那层由 installSidebarRoot 补
  //（皮肤写 `… > div { background: … }` 指着内容容器；只补列内层才不会让 `> div` 落到错位元素）
  check('转义层实现侧栏内容容器', eacEscapeSrc.includes('function installSidebarRoot'))
  check('侧栏内容容器带认领属性', eacEscapeSrc.includes('data-dsh-sidebar-root'))
  for (const pane of ['sidebar', 'conversation', 'details']) {
    check(`转义层补 data-pane=${pane}`, eacEscapeSrc.includes(`'data-pane': '${pane}'`))
  }
  check('矫正层钉住侧栏层叠（z-index）', eacEscapeSrc.includes('z-index: 200 !important'))
  check('矫正层给内容容器列内布局', eacEscapeSrc.includes('#left-sidebar > [data-dsh-sidebar-root]'))
  check('矫正层把列内边距迁到内容容器', eacEscapeSrc.includes('padding: 0 !important'))
  check('转义层补会话列顶栏钩子', eacEscapeSrc.includes(`'data-dsh-conv-header': null`))
  check('转义层补会话树 role=treeitem', eacEscapeSrc.includes(`setHook(el, 'role', 'treeitem')`))
  // 皮肤自己按 data-ds-dark-theme 分支、亮暗两套都在 —— 声明固定配色会被锁死成单色。
  // maid-atelier 是例外：整体就是深海蓝一套暗色，显式声明 dark 让加载器锁住宿主主题。
  const FIXED_SCHEME_SKINS: Record<string, string> = { 'maid-atelier': 'dark' }
  for (const id of EAC_SKINS) {
    const dir = join(SKILL_DIR, 'themes', id)
    const metaPath = join(dir, 'skin.json')
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null
    check(`${id}: 皮肤包齐备（skin.json/css/js）`,
      !!meta && existsSync(join(dir, 'skin.css')) && existsSync(join(dir, 'skin.js')))
    if (!meta) continue
    check(`${id}: 声明 css 与 script`, meta.css === 'skin.css' && meta.script === 'skin.js')
    check(`${id}: 声明 bodyAttr 作用域`, String(meta.scope?.bodyAttribute || '').startsWith('data-dsh-'))
    if (FIXED_SCHEME_SKINS[id]) {
      check(`${id}: 声明固定配色 ${FIXED_SCHEME_SKINS[id]}`,
        meta.colorScheme === FIXED_SCHEME_SKINS[id], String(meta.colorScheme))
    } else {
      check(`${id}: 未声明固定配色（亮暗双套）`, !meta.colorScheme, String(meta.colorScheme))
    }
    const js = readFileSync(join(dir, 'skin.js'), 'utf8')
    check(`${id}: 脚本导出 apply`, js.includes('export const apply ='))
    check(`${id}: 保留上游 factory 原文`, js.includes('const factory = (require) => {'))
    const cssText = readFileSync(join(dir, 'skin.css'), 'utf8')
    check(`${id}: CSS 保留 DSH 0.2 根契约（未被硬改）`, cssText.includes('[id=root]'))
    check(`${id}: CSS 带作用域前缀`, cssText.includes(`body[${meta.scope.bodyAttribute}]`))
  }

  // 行为断言：真跑一遍 activateSkin，确认注入宿主的样式已被改写、三列拿到窗格标记。
  const eacHost = createDshThemeHost({ skillDir: SKILL_DIR })
  const { port: eacPort } = await eacHost.start()
  const eacStore: Record<string, any> = {}
  const mkEacEl = (parent: any = null) => {
    const attrs = new Map<string, string>()
    const cls = new Set<string>()
    const el: any = {
      parentElement: parent,
      children: [] as any[],
      dataset: {} as Record<string, string>,
      textContent: '',
      innerHTML: '',
      id: '',
      classList: {
        contains: (c: string) => cls.has(c),
        add: (c: string) => { cls.add(c) },
        remove: (c: string) => { cls.delete(c) },
      },
      get firstElementChild() { return el.children[0] || null },
      getAttribute: (n: string) => (attrs.has(n) ? attrs.get(n)! : null),
      setAttribute: (n: string, v: string) => { attrs.set(n, v) },
      removeAttribute: (n: string) => { attrs.delete(n) },
      hasAttribute: (n: string) => attrs.has(n),
      getBoundingClientRect: () => ({ width: 0, left: 0, right: 0 }),
      // 元素级查询：侧栏内容容器（installSidebarRoot）靠它在列内找固定子节点
      querySelector: (sel: string) => eacEl(sel),
      querySelectorAll: () => [],
      // 真节点树语义：appendChild / insertBefore 要维护 children 与 parentElement，
      // 侧栏内容容器靠它才能被测到
      appendChild(node: any) { node.parentElement = el; el.children.push(node) },
      insertBefore(node: any, ref: any) {
        node.parentElement = el
        const i = el.children.indexOf(ref)
        if (i >= 0) el.children.splice(i, 0, node); else el.children.push(node)
      },
      prepend() {}, remove() {},
      style: { setProperty() {}, removeProperty() {}, display: '' },
    }
    return el
  }
  // #left-sidebar 是 #body-row 的子节点（转义层会在两者之间垫一层 slot 包装）
  const eacEl = (sel: string) => {
    if (!eacStore[sel]) eacStore[sel] = mkEacEl(sel === '#left-sidebar' ? eacEl('#body-row') : null)
    return eacStore[sel]
  }
  const eacCreated: any[] = []
  const eacRootEl = eacEl('#documentElement')
  const eacBodyEl = eacEl('#body')
  const eacDoc = {
    title: '',
    body: eacBodyEl,
    documentElement: eacRootEl,
    head: { appendChild() {} },
    createElement: () => { const el = mkEacEl(); eacCreated.push(el); return el },
    getElementById: (id: string) => eacCreated.find((e) => e.id === id) || null,
    querySelector: (sel: string) => (sel.includes('meta') ? null : eacEl(sel)),
    querySelectorAll: (sel: string) =>
      ['#left-sidebar', '#main-content', '#info-panel', '#header', '#left-sidebar .session-item'].includes(sel)
        ? [eacEl(sel)] : [],
    addEventListener() {}, removeEventListener() {},
  }
  class EacMutationObserver {
    constructor(private readonly cb: () => void) {}
    observe() {} disconnect() {}
  }
  const eacGlobals = globalThis as unknown as {
    document?: unknown; window?: unknown; MutationObserver?: unknown;
    requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown;
  }
  eacGlobals.document = eacDoc
  eacGlobals.window = {
    innerWidth: 1440, addEventListener() {}, removeEventListener() {},
    __SEEK_THEME_HOST: `http://127.0.0.1:${eacPort}`,
  }
  eacGlobals.MutationObserver = EacMutationObserver
  eacGlobals.requestAnimationFrame = (cb: () => void) => { cb(); return 1 }
  eacGlobals.cancelAnimationFrame = () => {}

  const eacRes = await loader.activateSkin('minecraft')
  check('EAC 皮肤可激活', eacRes.ok === true, JSON.stringify(eacRes))
  const injected = eacCreated.find((e) => String(e.id).startsWith('dsh-theme-skin-'))
  check('注入的样式已把 [id=root] 改成 #app', !!injected
    && injected.textContent.includes('#app')
    && !injected.textContent.includes('[id=root]'))
  const eacSidebar = eacEl('#left-sidebar')
  check('侧栏拿到 data-pane=sidebar', eacSidebar.getAttribute('data-pane') === 'sidebar')
  const eacSidebarRoot = eacSidebar.children.find((c: any) => c.hasAttribute?.('data-dsh-sidebar-root'))
  check('侧栏内补了内容容器（带认领标记）', !!eacSidebarRoot)
  check('内容容器收进固定子节点（顶栏/新建按钮/会话树/spacer）',
    eacSidebarRoot?.children.length === 4, String(eacSidebarRoot?.children.length))
  check('会话列拿到 data-pane=conversation', eacEl('#main-content').getAttribute('data-pane') === 'conversation')
  check('右侧栏拿到 data-pane=details', eacEl('#info-panel').getAttribute('data-pane') === 'details')
  check('会话列顶栏打了 data-dsh-conv-header 钩子', eacEl('#header').getAttribute('data-dsh-conv-header') === '')
  check('会话树补 role=treeitem', eacEl('#left-sidebar .session-item').getAttribute('role') === 'treeitem')
  check('皮肤作用域属性落到 body', eacBodyEl.getAttribute('data-dsh-minecraft') !== null)
  await loader.deactivateSkin()
  eacHost.stop()
  delete eacGlobals.document
  delete eacGlobals.window
  delete eacGlobals.MutationObserver
  delete eacGlobals.requestAnimationFrame
  delete eacGlobals.cancelAnimationFrame

  // ── 6.5 固定配色皮肤：锁定宿主亮暗（DOM 桩跑真实链路）──
  console.log('\n【6.5】固定配色皮肤的主题锁定')
  const pinSrc = readFileSync(join(SKILL_DIR, 'client', 'theme-loader.js'), 'utf8')
  check('加载器实现配色锁定', pinSrc.includes('function pinColorScheme'))
  check('只认 dark / light 两种声明', pinSrc.includes("scheme !== 'dark' && scheme !== 'light'"))
  check('监听宿主主题属性变化', /attributeFilter: \['data-theme'\]/.test(pinSrc))
  check('换皮肤跳过中途还原（不闪宿主配色）', pinSrc.includes('deactivateSkin({ restoreTheme: false })'))
  check('卸载时还原用户偏好', pinSrc.includes('restoreUserTheme(detachPin())'))

  // 行为断言：App 默认亮色（localStorage 无记录时 light），皮肤声明暗色 → 必须被钉住；
  // App 按用户偏好写回亮色 → 立刻钉回并记住偏好；卸载 → 偏好还原。
  const pinHost = createDshThemeHost({ skillDir: SKILL_DIR })
  const { port: pinPort } = await pinHost.start()

  let themeValue = 'light'
  type MoEntry = { target: unknown; filter: string[]; fire: () => void }
  const moRegistry: MoEntry[] = []
  class MutationObserverStub {
    private entry: MoEntry | null = null
    constructor(private readonly cb: () => void) {}
    observe(target: unknown, opts: { attributeFilter?: string[] } = {}) {
      this.entry = { target, filter: opts.attributeFilter || [], fire: () => this.cb() }
      moRegistry.push(this.entry)
    }
    disconnect() {
      if (!this.entry) return
      const i = moRegistry.indexOf(this.entry)
      if (i >= 0) moRegistry.splice(i, 1)
    }
  }

  const mkStubEl = () => {
    const attrs = new Map<string, string>()
    const cls = new Set<string>()
    return {
      children: [] as unknown[],
      dataset: {} as Record<string, string>,
      textContent: '',
      id: '',
      classList: {
        contains: (c: string) => cls.has(c),
        add: (c: string) => { cls.add(c) },
        remove: (c: string) => { cls.delete(c) },
      },
      getAttribute: (n: string) => (attrs.has(n) ? attrs.get(n)! : null),
      setAttribute: (n: string, v: string) => { attrs.set(n, v) },
      removeAttribute: (n: string) => { attrs.delete(n) },
      hasAttribute: (n: string) => attrs.has(n),
      getBoundingClientRect: () => ({ width: 0, left: 0, right: 0 }),
      // 侧栏内容容器（installSidebarRoot）会在列内找固定子节点
      querySelector: () => null,
      appendChild() {}, prepend() {}, remove() {},
      style: { setProperty() {}, removeProperty() {} },
    }
  }
  const rootStub = mkStubEl()
  Object.defineProperty(rootStub.dataset, 'theme', {
    get: () => themeValue,
    set: (v: string) => {
      themeValue = v
      // 属性变更通知：只喂给盯着 documentElement 的观察者（属性钩子语义）
      for (const entry of [...moRegistry]) {
        if (entry.target === rootStub && entry.filter.includes('data-theme')) entry.fire()
      }
    },
  })

  const pinAppEl = mkStubEl()
  const pinSidebarEl = mkStubEl()
  const pinPanelEl = mkStubEl()
  const pinListEl = mkStubEl()
  const pinBodyEl = mkStubEl()
  const pinDocEls: Record<string, unknown> = {
    '#app': pinAppEl,
    '#left-sidebar': pinSidebarEl,
    '#info-panel': pinPanelEl,
    '#message-list': pinListEl,
  }
  const pinDoc = {
    title: '',
    body: pinBodyEl,
    documentElement: rootStub,
    head: { appendChild() {} },
    createElement: () => mkStubEl(),
    getElementById: () => null,
    querySelector: (sel: string) => (sel.includes('meta') ? null : pinDocEls[sel] || null),
    querySelectorAll: () => [] as unknown[],
    addEventListener() {}, removeEventListener() {},
  }
  const pinWindow = {
    innerWidth: 1440,
    addEventListener() {}, removeEventListener() {},
    __SEEK_THEME_HOST: `http://127.0.0.1:${pinPort}`,
  }
  const g2 = globalThis as unknown as {
    document?: unknown; window?: unknown; MutationObserver?: unknown;
    requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown;
  }
  g2.document = pinDoc
  g2.window = pinWindow
  g2.MutationObserver = MutationObserverStub
  g2.requestAnimationFrame = (cb: () => void) => { cb(); return 1 }
  g2.cancelAnimationFrame = () => {}

  const pinRes = await loader.activateSkin('roxy-celestial-library')
  check('皮肤激活成功（锁定的前提）', pinRes.ok === true, JSON.stringify(pinRes))
  check('宿主的亮色被钉成皮肤的暗色', themeValue === 'dark', themeValue)
  check('DSH 暗色属性同步跟着钉住', pinBodyEl.getAttribute('data-ds-dark-theme') === '')
  // 模拟用户按亮暗开关：App 的 useEffect 写 html[data-theme]='light'（走属性写入才会有观察者事件）
  rootStub.dataset.theme = 'light'
  check('App 写回亮色后被立刻钉回暗色', themeValue === 'dark', themeValue)
  await loader.deactivateSkin()
  check('卸载皮肤后把用户偏好（亮色）还原', themeValue === 'light', themeValue)

  pinHost.stop()
  delete g2.document
  delete g2.window
  delete g2.MutationObserver
  delete g2.requestAnimationFrame
  delete g2.cancelAnimationFrame

  // ── 7. 主进程接线 ──
  console.log('\n【7】主进程接线')
  const mainSrc = readFileSync(join(ROOT, 'electron', 'main.js'), 'utf8')
  check('启动函数已定义', mainSrc.includes('async function startDshTheme()'))
  check('注入函数已定义', mainSrc.includes('async function injectDshTheme('))
  check('就绪等待函数已定义', mainSrc.includes('async function injectDshThemeWhenReady('))
  check('已挂进启动流程', mainSrc.includes('await startDshTheme();'))
  check('已挂进注入流程', mainSrc.includes('injectDshThemeWhenReady(mainWindow)'))
  check('已进插件清单', mainSrc.includes("'dsh-theme'"))
  check('已接请求头改写', mainSrc.includes('installLocalHostRequestRewrite(port)'))
  // 注入端不得再碰共享槽 __SEEK_EXT_HOST（视觉卡片宿主也写它，谁晚谁赢）
  const themeInjection = mainSrc.slice(
    mainSrc.indexOf('async function injectDshTheme('),
    mainSrc.indexOf('async function injectDshThemeWhenReady('),
  )
  check('主题注入写专属 __SEEK_THEME_HOST',
    themeInjection.includes("window.__SEEK_THEME_HOST = 'http://127.0.0.1:${port}';"))
  check('主题注入不再写共享 __SEEK_EXT_HOST', !themeInjection.includes('window.__SEEK_EXT_HOST'))
  // onBeforeSendHeaders 是单监听器语义，一条 host 通配才盖得住后起的挂件端口
  check('请求头改写按 host 通配安装', mainSrc.includes("{ urls: ['http://127.0.0.1/*'] }"))

  // ── 8. 设置面板「主题」栏目 ──
  console.log('\n【8】设置面板「主题」栏目')
  // 8.1 渲染层扩展点
  const extSrc = readFileSync(join(ROOT, 'electron', 'renderer', 'src', 'utils', 'settings-extension.ts'), 'utf8')
  check('扩展点提供注册接口', extSrc.includes('export function registerSettingsSection('))
  check('扩展点提供注销接口', extSrc.includes('export function unregisterSettingsSection('))
  check('扩展点提供列表接口', extSrc.includes('export function listSettingsSections('))
  check('扩展点按 order 排序', extSrc.includes('.sort(') && extSrc.includes('order'))
  check('扩展点挂到 window', extSrc.includes('__SEEK_SETTINGS_EXTENSION'))

  // 8.2 设置面板消费
  const panelSrc = readFileSync(join(ROOT, 'electron', 'renderer', 'src', 'components', 'SettingsPanel.tsx'), 'utf8')
  check('面板 import 扩展点', panelSrc.includes("settings-extension.ts'"))
  check('面板订阅插件栏目', panelSrc.includes('setPluginSections(listSettingsSections())'))
  check('面板监听就绪事件', panelSrc.includes("'seek:settings-extension-ready'"))
  check('面板区分插件栏目 key', panelSrc.includes('PLUGIN_GROUP_PREFIX'))
  check('面板渲染插件栏目', panelSrc.includes('<PluginSectionHost'))
  check('面板兜住插件渲染异常', panelSrc.includes('渲染失败'))

  // 8.3 React 回填
  const mainTsx = readFileSync(join(ROOT, 'electron', 'renderer', 'src', 'main.tsx'), 'utf8')
  check('main.tsx 回填 React 本体', mainTsx.includes('__SEEK_SETTINGS_EXTENSION!.react = React'))
  check('main.tsx 加载扩展点模块', mainTsx.includes("settings-extension.ts'"))

  // 8.4 插件侧栏目脚本
  const panelScript = readFileSync(join(SKILL_DIR, 'client', 'settings-panel.js'), 'utf8')
  check('栏目脚本无 export（executeJavaScript 可执行）', !/^\s*export\s/m.test(panelScript))
  check('栏目脚本注册 label=主题', panelScript.includes("label: '主题'"))
  check('栏目脚本自注册', panelScript.includes('window.__seekThemePanelUnregister = registerSettingsPanel()'))
  check('栏目脚本用 electronAPI', panelScript.includes('api.themeList') && panelScript.includes('api.themeActivate'))
  check('栏目脚本提示单色皮肤锁定亮暗', panelScript.includes('activeSkin.colorScheme'))

  // 8.5 主进程 RPC + preload 桥
  check('主进程有 theme:list', mainSrc.includes("registerRpc('theme:list'"))
  check('主进程有 theme:activate', mainSrc.includes("registerRpc('theme:activate'"))
  check('主进程热切换调用加载器', mainSrc.includes('window.__seekTheme.activate('))
  check('主进程注入栏目脚本', mainSrc.includes("'settings-panel.js'"))
  const preloadSrc = readFileSync(join(ROOT, 'electron', 'preload.cjs'), 'utf8')
  check('preload 暴露 themeList', preloadSrc.includes('themeList:'))
  check('preload 暴露 themeActivate', preloadSrc.includes('themeActivate:'))

  // ── 9. 插件设置卡片化（configSchema 驱动）──
  console.log('\n【9】插件设置卡片化')
  // 9.1 插件自报 configSchema
  for (const [name, key] of [
    ['dsh-theme', 'theme'],
    ['dsh-raw-html', 'trusted'],
    ['dsh-dafeiyu', 'scale'],
  ] as const) {
    const cfg = JSON.parse(readFileSync(join(SKILL_DIR, '..', name, 'enable.json'), 'utf8'))
    check(`${name} 声明了 configSchema`, Array.isArray(cfg.configSchema) && cfg.configSchema.length > 0)
    check(`${name} 的 schema 含 ${key}`, (cfg.configSchema || []).some((f: any) => f.key === key))
  }
  // 9.2 主进程聚合与统一写入
  check('清单返回 configSchema', mainSrc.includes('configSchema: Array.isArray(cfg.configSchema)'))
  check('清单返回当前配置值', mainSrc.includes('config,') && mainSrc.includes('const RESERVED'))
  check('有统一写入 API', mainSrc.includes("registerRpc('plugins:setConfig'"))
  check('写入按 schema 校验键', mainSrc.includes('无此配置项'))
  check('写入按范围夹取数字', mainSrc.includes('Math.max(field.min, n)') && mainSrc.includes('Math.min(field.max, n)'))
  check('有动态字段候选项 API', mainSrc.includes("registerRpc('plugins:fieldOptions'"))
  check('皮肤类型候选项由 host 提供', mainSrc.includes("field.type === 'skin'") && mainSrc.includes('listSkins()'))
  check('桌宠配置热应用', mainSrc.includes("name === 'dsh-dafeiyu' && petHost"))
  check('主题配置热应用', mainSrc.includes("name === 'dsh-theme'"))
  // 9.3 preload 桥
  check('preload 暴露 setPluginConfig', preloadSrc.includes('setPluginConfig:'))
  check('preload 暴露 getPluginFieldOptions', preloadSrc.includes('getPluginFieldOptions:'))
  // 9.4 前端卡片
  const panelSrc2 = readFileSync(join(ROOT, 'electron', 'renderer', 'src', 'components', 'SettingsPanel.tsx'), 'utf8')
  check('有可展开卡片组件', panelSrc2.includes('function PluginCard('))
  check('有字段编辑器组件', panelSrc2.includes('function PluginFieldEditor('))
  check('卡片支持展开态', panelSrc2.includes('expanded') && panelSrc2.includes('setExpanded'))
  check('按 schema 渲染字段', panelSrc2.includes('configSchema || []'))
  check('支持 skin 动态候选', panelSrc2.includes('getPluginFieldOptions'))
  check('编辑有草稿与脏标记', panelSrc2.includes('setDraft') && panelSrc2.includes('dirty'))
  check('已移除旧桌宠独立面板', !panelSrc2.includes('function PetConfigSection('))

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`通过 ${passed} / 失败 ${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('测试异常：', err)
  process.exit(1)
})





