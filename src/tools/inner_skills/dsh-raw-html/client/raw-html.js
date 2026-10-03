/**
 * dsh-raw-html 前端半区（DSH → seek-agent 移植版）—— 由 electron/main.js 注入渲染层执行。
 *
 * 上游（dsh-raw-html-v2）是 DSH Web 的 Cordis 插件：以官方 slot API 替换 assistant-step
 * 渲染器接入 React 树。seek-agent 没有 slot 体系，改用渲染层提供的**中立内容扩展点**
 * （utils/content-extension.ts）：本脚本注册一个正文渲染器，把助手正文切成
 * md / vcp / pending / page 四类段，vcp 段交给 v1 渲染引擎产出 React 元素。
 *
 * 渲染层对本插件**零知识**——不 import 本目录、不认识 vcp-root；未注册渲染器时走原路径。
 * 本脚本只依赖两个外部事实：
 *   window.__SEEK_EXT_HOST  本地宿主地址（由 main.js 注入；缺省则放弃，不报错）
 *   window.__SEEK_CONTENT_EXTENSION  渲染层提名的注册接口
 * 任一缺失即静默退出 → 删掉本目录 = 整体卸载，主功能不受影响。
 *
 * 资源来源（全部经宿主 HTTP 提供，不在渲染层留任何绝对路径）：
 *   /fonts/*.woff2         字体（<link rel=stylesheet> 的 url() 相对解析）
 *   /vendor/*.js|*.css     引擎 / KaTeX / Mermaid（动态 script/link 标签加载）
 */
(function () {
  'use strict'

  var HOST = String(window.__SEEK_EXT_HOST || '').replace(/\/+$/, '')
  var EXT = window.__SEEK_CONTENT_EXTENSION
  if (!HOST) {
    console.warn('[raw-html] 未注入 __SEEK_EXT_HOST（插件被禁用或主进程未托管），跳过')
    return
  }
  if (!EXT || typeof EXT.register !== 'function') {
    console.warn('[raw-html] 渲染层未提供内容扩展点，跳过')
    return
  }
  if (window.__dshRawHtmlLoaded) return
  window.__dshRawHtmlLoaded = true

  var log = function () { console.log.apply(console, ['[raw-html]'].concat([].slice.call(arguments))) }
  var loadScriptOnce = function (id, src, done) {
    if (document.getElementById(id)) { if (done) done(); return }
    var s = document.createElement('script')
    s.id = id
    s.src = src
    if (done) s.onload = done
    document.head.appendChild(s)
  }
  var loadStyleOnce = function (id, href) {
    if (document.getElementById(id)) return
    var l = document.createElement('link')
    l.id = id
    l.rel = 'stylesheet'
    l.href = href
    document.head.appendChild(l)
  }

  // ═══════════════════════════════════════════════════════
  // 字体服务：@font-face 以样式表形式从宿主拉取（url() 相对样式表解析 → 天然指向宿主）
  // 与上游的差别：上游在 Host 端按 fontsRoot 扫描磁盘字体并生成 css；这里用宿主
  // /fonts.css 直接产出（字体文件随插件分发，无外部字体根依赖）。
  // ═══════════════════════════════════════════════════════
  function ensureFonts() {
    loadStyleOnce('dsh-raw-html-fonts', HOST + '/fonts.css')
  }

  // ═══════════════════════════════════════════════════════
  // 外设：KaTeX（公式） / Mermaid（图表） / 色引擎
  // 引擎只管渲染，公式与图表的资源由这一层提供（引擎零硬编码路径，靠全局变量桥接）。
  // ═══════════════════════════════════════════════════════
  var mathReady = false
  function ensureMathAssets() {
    if (document.getElementById('dsh-raw-html-katex-css')) return
    loadStyleOnce('dsh-raw-html-katex-css', HOST + '/vendor/katex-vd.css')
    loadStyleOnce('dsh-raw-html-katex-css2', HOST + '/vendor/katex.min.css')
    loadScriptOnce('dsh-raw-html-katex', HOST + '/vendor/katex.min.js', function () {
      loadScriptOnce('dsh-raw-html-autorender', HOST + '/vendor/auto-render.min.js', null)
    })
  }
  function ensureMermaidAssets() {
    loadScriptOnce('dsh-raw-html-mermaid', HOST + '/vendor/mermaid.min.js', null)
  }
  function ensureColorEngine() {
    if (window.VCPColorEngine || window.__vcpColor) return
    loadScriptOnce('dsh-raw-html-color', HOST + '/vendor/VCPColorEngine.js', null)
  }

  // ═══════════════════════════════════════════════════════
  // 渲染引擎装载：上游用同步 XHR 取引擎源码再 new Function 注入 shim；
  // 这里改成动态 <script> 标签（渲染层用 file:// 页面，同步 XHR 对 http 跨源易被拦），
  // 由宿主在源码尾部追加一行自注册片段完成同样的注入。
  // ═══════════════════════════════════════════════════════
  var engineState = { tried: 0, ready: false }

  function makeVcShim(React) {
    /**
     * 引擎的 vc(node, key)：把 DOM 节点翻成 React 元素。
     * 与上游 shim 的差别有意收窄——M1 不开可信模式：
     *   - script/object/embed 一律丢弃（脚本由宿主决定是否执行）；
     *   - on* 事件属性一律剥离（只保留 input('...') 桥，走渲染层自己的发送通道）；
     *   - href/src 做协议白名单（防 javascript: / data:text/html）。
     * 这样卡内 HTML/CSS/SVG/公式/图表全可用，但拿不到任何脚本执行能力。
     */
    var createElement = React.createElement
    function allowHref(v) { return /^(https?:|mailto:|\/|#)/i.test(v) }
    function allowSrc(v) { return /^(https?:|data:image\/|\/|#)/i.test(v) }

    function toStyle(s) {
      var r = {}
      var parts = String(s || '').split(';')
      for (var i = 0; i < parts.length; i++) {
        var idx = parts[i].indexOf(':')
        if (idx === -1) continue
        var k = parts[i].slice(0, idx).trim().replace(/-([a-z])/g, function (h, p) { return p.toUpperCase() })
        r[k] = parts[i].slice(idx + 1).trim()
      }
      return r
    }

    /** 样式脱敏：剥掉能逃出卡片的定位/层叠与伪元素内容（同上游 vcpFilterStyle） */
    function filterStyle(sv) {
      return String(sv || '')
        .replace(/position\s*:\s*fixed\s*;?/gi, '')
        .replace(/z-index\s*:\s*\d{4,}\s*;?/gi, '')
        .replace(/(?<![\w-])content\s*:[^;]*;?/gi, '')
    }

    return function vc(node, key) {
      if (!node) return null
      if (node.nodeType === 3) return node.textContent
      if (node.nodeType !== 1) return null
      var tag = node.localName
      if (tag === 'script' || tag === 'object' || tag === 'embed') return null
      if (tag === 'iframe') {
        var fsrc = ''
        for (var fi = 0; fi < node.attributes.length; fi++) {
          if (node.attributes[fi].name === 'src') { fsrc = node.attributes[fi].value; break }
        }
        if (!/^(https?:|\/)/i.test(fsrc)) return null
      }
      var props = { key: key }
      for (var i = 0; i < node.attributes.length; i++) {
        var c = node.attributes[i]
        var nm = c.name
        if (nm === 'onclick') {
          // 唯一放行的交互：input('...') 桥（让卡片能替用户发一句话）
          var m = /^input\s*\(\s*['"]([\s\S]*?)['"]\s*\)\s*;?\s*$/.exec(c.value)
          if (m) {
            props.onClick = (function (text) {
              return function () {
                var send = window.electronAPI && window.electronAPI.sendInput
                if (typeof send === 'function') send(text)
              }
            })(m[1])
          }
          continue
        }
        if (/^on/i.test(nm)) continue
        if (nm === 'style') { props.style = toStyle(filterStyle(c.value)); continue }
        if (nm === 'class') { props.className = c.value; continue }
        if (nm === 'href' && !allowHref(c.value)) continue
        if (nm === 'src' && !allowSrc(c.value)) continue
        if (nm === 'allowfullscreen') { props.allowFullScreen = true; continue }
        props[nm] = c.value
      }
      var kids = []
      for (var j = 0; j < node.childNodes.length; j++) {
        var ch = vc(node.childNodes[j], j)
        if (ch !== null && ch !== undefined) kids.push(ch)
      }
      return createElement(tag, props, kids.length ? kids : undefined)
    }
  }

  function makeHpShim() {
    return function hp(s) {
      var r = {}
      var parts = String(s || '').split(';')
      for (var i = 0; i < parts.length; i++) {
        var idx = parts[i].indexOf(':')
        if (idx === -1) continue
        var k = parts[i].slice(0, idx).trim().replace(/-([a-z])/g, function (h, p) { return p.toUpperCase() })
        r[k] = parts[i].slice(idx + 1).trim()
      }
      return r
    }
  }

  function ensureEngine() {
    if (window.__vcpStable && typeof window.__vcpStable.render === 'function') {
      engineState.ready = true
      return
    }
    if (engineState.tried > 5) return
    engineState.tried += 1
    // 引擎源码是 IIFE，内部 vc / hp / f 是未声明的自由变量 → 沿作用域链上溯到全局对象。
    // 因此把注入值挂到 window 上，宿主在脚本尾部追加的自注册片段再确认就绪。
    window.vc = makeVcShim(React)
    window.hp = makeHpShim()
    window.f = { Fragment: React.Fragment, jsx: React.createElement }
    var s = document.createElement('script')
    s.id = 'dsh-raw-html-engine'
    s.src = HOST + '/vendor/vcp-engine-v1.js'
    s.onload = function () {
      engineState.ready = !!(window.__vcpEngineReady &&
        window.__vcpStable && typeof window.__vcpStable.render === 'function')
      if (!engineState.ready) console.warn('[raw-html] 引擎脚本已加载但未注册（跳过）')
      else log('渲染引擎就绪')
    }
    s.onerror = function () { console.warn('[raw-html] 引擎脚本加载失败') }
    document.head.appendChild(s)
  }

  // ═══════════════════════════════════════════════════════
  // 正文切段（移植自上游 splitVcpText 及其配套扫描器）
  // ═══════════════════════════════════════════════════════
  var PAGE_OPEN_RE = /(?:^|[\r\n]{1,2})(<!doctype\s+html\b[^>]*>|<html\b[^>]*>)/gi

  /** 找行首的 <div id="vcp-root"> 开标签；行内提及（说明文字里的字样）不算卡片 */
  function findVcpOpen(text, from) {
    var t = String(text || '')
    var re = /<div\b[^>]*?\bid\s*=\s*["']vcp-root["'][^>]*>/gi
    re.lastIndex = from || 0
    var m = null
    while ((m = re.exec(t))) {
      var lineStart = t.lastIndexOf('\n', m.index - 1) + 1
      if (/^[ \t]*$/.test(t.slice(lineStart, m.index))) return { start: m.index, end: re.lastIndex }
    }
    return null
  }

  /** 配平 div 嵌套，返回尾部第一个 </div> 的下一个位置；未闭合返回 -1（流式中） */
  function scanVcpDiv(html, openEnd) {
    var depth = 1
    var i = openEnd
    var len = html.length
    while (i < len) {
      var lt = html.indexOf('<', i)
      if (lt === -1) break
      if (html.startsWith('<!--', lt)) {
        var ce = html.indexOf('-->', lt + 4)
        if (ce === -1) break
        i = ce + 3
        continue
      }
      var gt = html.indexOf('>', lt + 1)
      if (gt === -1) break
      var raw = html.slice(lt, gt + 1)
      var name = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw)
      var isClose = /^<\s*\//.test(raw)
      var selfClose = /\/\s*>$/.test(raw) ||
        /^<\s*(?:!|meta|link|br|hr|img|input|source|area|base|col|embed|track|wbr)\b/i.test(raw)
      if (name && !isClose && !selfClose) {
        var nm = name[1].toLowerCase()
        if (nm === 'div') depth += 1
        else if (/^(script|style|textarea|title)$/.test(nm)) {
          // RAW 文本元素：其内容里的 </div> 不是标签
          var closer = html.toLowerCase().indexOf('</' + nm + '>', gt + 1)
          if (closer === -1) break
          i = closer + nm.length + 3
          continue
        }
      } else if (isClose && name) {
        if (name[1].toLowerCase() === 'div') {
          depth -= 1
          if (depth <= 0) return { start: -1, end: gt + 1 }
        }
      }
      i = gt + 1
    }
    return { start: -1, end: -1 }
  }

  /** 吞掉卡片尾部紧跟的 <style>/<script>（作用域化需要它们随卡） */
  function swallowTrailingRaw(text, end) {
    var pos = end
    while (pos < text.length) {
      var i = pos
      while (i < text.length && /\s/.test(text[i])) i++
      var m = /^<(style|script)\b[\s\S]*?(?:<\/\1>|$)/i.exec(text.slice(i))
      if (!m || m[0].length === 0) return pos
      pos = i + m[0].length
    }
    return pos
  }

  /** 整页 HTML（<!DOCTYPE html> / <html）起点，须在行首 */
  function findPageOpen(text, from) {
    var t = String(text || '')
    var re = PAGE_OPEN_RE
    re.lastIndex = from || 0
    var m = re.exec(t)
    if (!m) return null
    var tag = m[1] || m[2]
    return { start: m.index + m[0].length - tag.length, tagEnd: m.index + m[0].length }
  }
  function scanPageEnd(text, after) {
    var m = /<\/html\s*>/i.exec(String(text || '').slice(after))
    return m ? after + m.index + m[0].length : -1
  }

  /** 围栏包装剥离：```html\n <卡> \n``` 时围栏行不进 md */
  function stripFenceWrapper(md) {
    var t = String(md || '')
    t = t.replace(/^[ \t]*```[^\n]*\n+/, '')
    t = t.replace(/\n[ \t]*```[ \t]*\n?$/, '')
    return t
  }

  /**
   * 剥掉 md 段尾部「未写完的开标签」：流式起始 <div id="vcp-r… 会被 findVcpOpen 漏掉，
   * 若照常渲染会在卡片出现前闪一帧源码文本。剥掉即可（下一帧 id 凑齐走卡片路径）。
   */
  function trimTrailingOpenTag(s) {
    var out = String(s || '')
    var guard = 0
    while (guard++ < 8) {
      var lt = out.lastIndexOf('<')
      if (lt === -1) break
      if (out.indexOf('>', lt) !== -1) break
      if (!/^<[a-zA-Z]/.test(out.slice(lt))) break
      out = out.slice(0, lt)
    }
    return out
  }

  /**
   * 把一条助手正文切成段：
   *   { type:'md',      text }  普通 markdown
   *   { type:'vcp',     html }  完整闭合的卡片
   *   { type:'pending', text }  卡片已开未闭合（流式中，喂引擎增量生长）
   *   { type:'page',    html }  整页 HTML（M1 不渲染，由调用侧降级为 md）
   */
  function splitVcpText(text) {
    var out = []
    var t = String(text || '')
    var pos = 0
    var mdStart = 0
    while (pos < t.length) {
      var openV = findVcpOpen(t, pos)
      var openP = findPageOpen(t, pos)
      var useP = openP && (!openV || openP.start < openV.start)
      if (!openV && !openP) break
      var start = useP ? openP.start : openV.start
      if (start > mdStart) {
        var mdSeg = trimTrailingOpenTag(stripFenceWrapper(t.slice(mdStart, start)))
        if (mdSeg) out.push({ type: 'md', text: mdSeg })
      }
      if (useP) {
        var pEnd = scanPageEnd(t, openP.tagEnd)
        if (pEnd === -1) {
          out.push({ type: 'page', text: t.slice(start) })
          mdStart = t.length
          break
        }
        out.push({ type: 'page', html: t.slice(start, pEnd) })
        mdStart = pEnd
        pos = pEnd
        continue
      }
      var scan = scanVcpDiv(t, openV.end)
      if (scan.end === -1) {
        out.push({ type: 'pending', text: t.slice(openV.start) })
        mdStart = t.length
        break
      }
      var end = swallowTrailingRaw(t, scan.end)
      out.push({ type: 'vcp', html: t.slice(openV.start, end) })
      mdStart = end
      pos = end
    }
    if (mdStart < t.length) {
      var tailMd = trimTrailingOpenTag(stripFenceWrapper(t.slice(mdStart)))
      if (tailMd) out.push({ type: 'md', text: tailMd })
    }
    return out
  }

  // ═══════════════════════════════════════════════════════
  // 渲染器：注册到渲染层的中立内容扩展点
  // ═══════════════════════════════════════════════════════
  var React = window.__seekReact
  var settleMemo = new Map() // key → { html, el }，非流式同一段内容复用上帧元素

  /**
   * 可信模式（enable.json 的 trusted，由宿主读入并经 main.js 注入为 __SEEK_RAW_HTML_TRUSTED）。
   * 关闭时：卡内 <script> 与全部 on* 事件被丢弃、不执行（M1 行为，默认）。
   * 开启时：含脚本的卡整卡改在 iframe 沙箱内渲染与执行——脚本能力被限制在沙箱文档里，
   *        既拿不到渲染层的 electronAPI，也拿不到父页 DOM。
   */
  var TRUSTED = window.__SEEK_RAW_HTML_TRUSTED === true

  /**
   * 抽卡片自带的 <style> 交给沙箱页：卡片视觉与 M1 非可信路径保持一致，
   * 差别只是这次由子文档来承载样式与脚本。
   * 同时把卡内 input('…') 的 onclick 改写成 data-vcp-input，供沙箱的统一委托识别
   * （沙箱里 inline handler 也能跑，但走属性更可控）。
   */
  function sandboxCardCss(html) {
    var css = ''
    var re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
    var m = null
    while ((m = re.exec(String(html || '')))) css += m[1] + '\n'
    return css
  }

  /**
   * 卡片里是否含可执行脚本（可信模式的判据）。
   * 用 DOM 解析而非正则，避免把注释里/字符串里的 "<script" 误判成脚本。
   */
  var _probe = null
  function cardHasScript(html) {
    if (!html || String(html).indexOf('<script') === -1) return false
    try {
      if (!_probe) {
        var DP = window.DOMParser || (typeof DOMParser !== 'undefined' ? DOMParser : null)
        if (!DP) return /<script[\s>]/i.test(html)
        _probe = new DP()
      }
      var doc = _probe.parseFromString(String(html), 'text/html')
      return !!doc.querySelector('script')
    } catch (e) {
      return /<script[\s>]/i.test(html)
    }
  }

  /** 把一段卡片 HTML 变成 React 元素 */
  function renderCard(html, streaming, key) {
    // 可信模式：卡内含 <script> → 整卡改走隔离沙箱（脚本在沙箱里执行，主文档不接触）
    if (TRUSTED && cardHasScript(html)) {
      return makeSandboxFrame({
        key: key,
        mode: 'card',
        html: html,
        css: sandboxCardCss(html),
        minHeight: 160,
      })
    }
    if (!engineState.ready || !window.__vcpStable || typeof window.__vcpStable.render !== 'function') {
      return React.createElement('div', {
        key: key,
        style: { padding: '6px 0', fontSize: '12px', color: 'var(--text-secondary, #999)' },
      }, streaming ? '正在生成视觉卡片…' : '（视觉卡片引擎未就绪）')
    }
    var raw = String(html || '')
    // 字体 url 归一：上游协议文档里写 url('/fonts/…')，宿主路由同为 /fonts/，无需改写；
    // 这里只兜住历史模板可能带的 /fonts-v2/ 写法。
    raw = raw.replace(/url\(\s*(['"]?)\/fonts-v2\//gi, 'url($1/fonts/')

    if (streaming !== true && key) {
      var hit = settleMemo.get(key)
      if (hit && hit.html === raw && hit.el) return React.createElement(React.Fragment, { key: key }, hit.el)
    }
    var el = null
    try {
      if (typeof window.__vcpStable.fixBlank === 'function') {
        try { raw = window.__vcpStable.fixBlank(raw) } catch (e) { /* 压缩失败按原样 */ }
      }
      el = window.__vcpStable.render(raw, streaming === true)
    } catch (err) {
      console.warn('[raw-html] 引擎渲染异常，本段降级为源码：', (err && err.message) || err)
      return null
    }
    if (el === null || el === undefined) return null
    // 包一层 MathPass：卡片挂到 DOM 之后再强制跑一次 KaTeX。
    // 引擎自身的 ref 回调在 React commit 阶段触发，早于浏览器完成布局，
    // 且 processMath 以 dataset.vcpMathDone 做了「只跑一次」闩锁——若那一刻 KaTeX
    // 尚未就绪或节点已换，公式就永远渲染不出来。这里在 useEffect（committed 之后）
    // 补一次，并对未就绪/未渲染的情况做有限重试。
    // 注意：缓存要存【包好之后】的元素，否则命中缓存的路径绕过了 MathPass，公式又丢了。
    var wrapped = React.createElement(MathPass, { key: key, htmlKey: key, streaming: streaming === true },
      React.createElement(React.Fragment, null, el))
    if (streaming !== true && key) settleMemo.set(key, { html: raw, el: wrapped })
    if (settleMemo.size > 80) settleMemo.clear()
    return wrapped
  }

  /**
   * 卡片 KaTeX 强制通道。
   * 挂载/更新后（useEffect 时机）对卡片根节点重跑一次公式渲染：
   *   1. 解流式占位（span.vcp-math-ph）——否则真实公式源码被包在占位里，auto-render 看不见；
   *   2. 调 window.__vcpMath.renderMathInContent 直接渲染（不经过 processMath 的一次性闩锁）；
   *   3. KaTeX 尚未就绪时按 200ms 重试（上限 ~6s，与引擎自身策略一致）。
   */
  function MathPass(props) {
    var ref = React.useRef ? React.useRef(null) : { current: null }
    var tries = React.useRef ? React.useRef(0) : { current: 0 }

    function run() {
      var root = ref.current
      if (!root || root.nodeType !== 1) return
      var M = window.__vcpMath
      if (!M || typeof M.renderMathInContent !== 'function') return
      // KaTeX 未就绪 → 有限重试
      if (typeof window.renderMathInElement !== 'function') {
        if (tries.current++ < 30) setTimeout(run, 200)
        return
      }
      try {
        if (typeof M.undecorateMathPlaceholders === 'function') M.undecorateMathPlaceholders(root)
        if (typeof M.normalizeMathTextNodes === 'function') M.normalizeMathTextNodes(root)
        M.renderMathInContent(root)
      } catch (e) { /* 渲染失败保留原文，不阻断卡片 */ }
    }

    if (React.useEffect) {
      // 内容或流式状态变化都重跑：流式期间每帧都尝试（auto-render 幂等，已渲染的 .katex 会被跳过）
      React.useEffect(function () {
        tries.current = 0
        run()
        // 非流式：再补一次，覆盖「挂载时 KaTeX 刚好还没 load 完」的窗口
        if (props.streaming !== true) {
          var t = setTimeout(run, 120)
          return function () { clearTimeout(t) }
        }
      }, [props.htmlKey, props.streaming])
    }

    return React.createElement('div', {
      className: 'vcp-math-host',
      ref: function (el) { ref.current = el },
      style: { display: 'contents' },
    }, props.children)
  }

  /**
   * 内容渲染器：返回 null 表示「本段无卡片，交回默认 markdown」。
   * 无卡片时整条交回 → 渲染层零额外开销，与插件不存在时完全一致。
   */
  function renderContent(content, state) {
    if (!content || content.indexOf('vcp-root') === -1) return null
    if (!engineState.ready) {
      ensureEngine()
      return null // 引擎就绪前一帧先走 markdown，下一帧接管
    }
    var segs = splitVcpText(content)
    var hasCard = false
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].type === 'vcp' || segs[i].type === 'pending') { hasCard = true; break }
    }
    if (!hasCard) return null

    var children = []
    var k = 0
    for (var j = 0; j < segs.length; j++) {
      var seg = segs[j]
      if (seg.type === 'vcp') {
        children.push(renderCard(seg.html, state.streaming, state.key + ':' + (k++)))
      } else if (seg.type === 'pending') {
        children.push(renderCard(seg.text, state.streaming, state.key + ':' + (k++)))
      } else if (seg.type === 'page') {
        // 整页程序页：交给隔离沙箱 iframe 渲染（脚本在沙箱内跑，不在渲染层文档里）
        children.push(makeSandboxFrame({
          key: state.key + ':' + (k++),
          mode: 'document',
          html: seg.html !== undefined && seg.html !== null ? seg.html : (seg.text || ''),
          minHeight: 220,
        }))
      } else if (seg.text) {
        var frags = splitMermaidFence(seg.text)
        for (var f = 0; f < frags.length; f++) {
          if (frags[f].type === 'mermaid') {
            children.push(renderCard(frags[f].html, state.streaming, state.key + ':' + (k++)))
          } else if (frags[f].text) {
            children.push(renderSegFallback(frags[f].text, state, k++))
          }
        }
      }
    }
    var keep = []
    for (var c = 0; c < children.length; c++) if (children[c] !== null) keep.push(children[c])
    if (!keep.length) return null
    return React.createElement('div', { className: 'vcp-html-host' }, keep)
  }

  // ═══════════════════════════════════════════════════════
  // 隔离沙箱 iframe：整页程序页与可信卡片的执行面
  //
  // 上游把卡内 <script> 直接 (0,eval) 在主文档跑——在 DSH Web 里只是页面脚本，
  // 但在 Electron 渲染层会够到 preload 暴露的 electronAPI（sendInput / setWorkdir /
  // undoPatch），等于把「卡内内容」升格成「本机能力」。这里改成 iframe 隔离：
  //   sandbox="allow-scripts"（**不给** allow-same-origin）→ 文档落在不透明源里，
  //   拿不到 parent 的 DOM、拿不到 electronAPI、拿不到 localStorage/IndexedDB；
  //   脚本照跑（canvas / SVG / 动画 / 事件全部可用），但只能在自己的沙箱里折腾。
  //
  // 与子页的协议只有三条（见 sandbox-frame.js 头注释）：投喂 html/css、回传高度、input 桥。
  // ═══════════════════════════════════════════════════════
  var SANDBOX_URL = HOST + '/client/sandbox-frame.html'

  /** 建立一次沙箱桥接：把父页收到的消息按 key 分发给各 frame 实例 */
  var sandboxBridges = {}
  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (!d || typeof d !== 'object' || !d.__vcpSandbox) return
    // 只认本插件沙箱页发来的消息：必须是本页的 iframe，且来源为「opaque（null）」——
    // 不给 allow-same-origin 的沙箱文档 origin 恒为 "null"，据此拒绝任何同源冒充。
    if (ev.origin !== 'null') return
    var keys = Object.keys(sandboxBridges)
    for (var i = 0; i < keys.length; i++) {
      var b = sandboxBridges[keys[i]]
      if (b && b.source === ev.source) { b.onMessage(d); return }
    }
  })

  function makeSandboxFrame(opts) {
    return React.createElement(SandboxFrame, {
      key: opts.key,
      frameKey: opts.key,
      mode: opts.mode || 'document',
      html: opts.html || '',
      css: opts.css || '',
      minHeight: opts.minHeight || 160,
    })
  }

  function SandboxFrame(props) {
    var frameKey = props.frameKey
    var iframeRef = React.useRef ? React.useRef(null) : { current: null }
    var [height, setHeight] = React.useState(props.minHeight)
    var latest = React.useRef ? React.useRef({ html: '', css: '' }) : { current: { html: '', css: '' } }
    latest.current.html = props.html
    latest.current.css = props.css

    function post(msg) {
      var el = iframeRef.current
      if (!el || !el.contentWindow) return
      try { el.contentWindow.postMessage(msg, '*') } catch (e) { /* 未就绪，忽略 */ }
    }
    function push() {
      var mode = props.mode
      var l = latest.current
      if (mode === 'style') post({ __vcpSandbox: 'style', css: l.css })
      else post({ __vcpSandbox: mode, html: l.html, css: l.css, streaming: props.streaming === true })
    }

    // 挂载/更新：沙箱就绪（ready）与内容变化都推一次，避免握手竞态
    React.useEffect(function () {
      return function () { delete sandboxBridges[frameKey] }
    }, [frameKey])

    React.useEffect(function () { push() }, [props.html, props.css, props.mode])

    return React.createElement('div', {
      className: 'vcp-sandbox-frame',
      style: {
        boxSizing: 'border-box', width: '100%', margin: '2px 0',
        borderRadius: '10px', overflow: 'hidden',
        border: '1px solid var(--border-primary, rgba(0,0,0,.12))',
        background: 'var(--bg-secondary, #fff)',
      },
    }, React.createElement('iframe', {
      ref: function (el) {
        iframeRef.current = el
        sandboxBridges[frameKey] = {
          source: el && el.contentWindow,
          onMessage: function (d) {
            if (d.__vcpSandbox === 'height') {
              var h = Math.max(props.minHeight, Math.min(2400, Number(d.height) || 0))
              setHeight(h)
            } else if (d.__vcpSandbox === 'input') {
              var send = window.electronAPI && window.electronAPI.sendInput
              if (typeof send === 'function' && d.text) send(d.text)
            } else if (d.__vcpSandbox === 'ready') {
              push() // 握手：子页已能收消息，补推一次内容
            }
          },
        }
      },
      src: SANDBOX_URL,
      sandbox: 'allow-scripts',
      title: 'VCP 沙箱',
      style: {
        display: 'block', width: '100%', border: '0',
        height: height + 'px', background: 'transparent',
      },
    }))
  }

  /** md 段兜底：用渲染层自己的 markdown 渲染器（不在插件内重复实现） */
  function renderSegFallback(text, state, k) {
    var md = EXT.renderMarkdown
    if (typeof md !== 'function') {
      return React.createElement('pre', { key: state.key + ':' + k }, text)
    }
    return React.createElement('div', {
      key: state.key + ':' + k,
      dangerouslySetInnerHTML: { __html: md(text) },
    })
  }

  /** md 段里的 ```mermaid 围栏 → 转成引擎认的形态（官方只显示代码块） */
  var MERMAID_FENCE_RE = /(^|\n)[ \t]*```[ \t]*mermaid[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/gi
  function splitMermaidFence(md) {
    var out = []
    var t = String(md || '')
    var re = MERMAID_FENCE_RE
    re.lastIndex = 0
    var last = 0
    var m = null
    while ((m = re.exec(t))) {
      var start = m.index + m[1].length
      if (start > last) out.push({ type: 'md', text: t.slice(last, start) })
      var esc = m[2].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      out.push({ type: 'mermaid', html: '<pre><code class="language-mermaid">' + esc + '</code></pre>' })
      last = m.index + m[0].length
    }
    if (last < t.length) out.push({ type: 'md', text: t.slice(last) })
    return out
  }

  // ═══════════════════════════════════════════════════════
  // 启动
  // ═══════════════════════════════════════════════════════
  if (!React || typeof React.createElement !== 'function') {
    console.warn('[raw-html] 渲染层未提名 React（__seekReact），插件放弃')
    return
  }
  ensureFonts()
  ensureMathAssets()
  ensureMermaidAssets()
  ensureColorEngine()
  ensureEngine()

  var unregister = EXT.register(renderContent)
  window.__dshRawHtmlUnmount = function () {
    try { if (typeof unregister === 'function') unregister() } catch (e) { /* 已注销 */ }
    window.__dshRawHtmlLoaded = false
  }
  log('已挂载：正文内容扩展点已注册，字体/公式/图表资源走宿主 ' + HOST)
})()

// ═══════════════════════════════════════════════════════════
// 宿主在 /vendor/vcp-engine-v1.js 尾部追加的自注册片段（等价于上游 new Function 注入）：
//
//   ;(function () {
//     if (typeof window.__vcpVc !== 'function') return
//     window.__vcpStable = __vcpStable
//   })()
//
// engine 的 render 依赖 f.jsx / f.Fragment——渲染层把 React 提名在 window.__seekReact，
// 宿主注入片段里把 f 设为 { Fragment: React.Fragment, jsx: React.createElement }。
// ═══════════════════════════════════════════════════════════
