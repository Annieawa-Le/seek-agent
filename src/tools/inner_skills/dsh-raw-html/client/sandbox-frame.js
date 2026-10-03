/**
 * dsh-raw-html 隔离运行页 —— 由宿主以 /client/sandbox-frame.html 提供给 iframe（srcdoc 不用，见下）。
 *
 * 为什么是独立页而不是 srcdoc：
 *   srcdoc 的文档与父页**同源**（about:srcdoc 继承父源），即使加了 sandbox 也共享 localStorage/
 *   IndexedDB，且未给 allow-same-origin 时又会丢掉本地资源相对路径。改为从宿主 http 源加载
 *   一个**独立文档**，配合 sandbox="allow-scripts"（不给 allow-same-origin）→ 文档落在
 *   不透明源（opaque origin）里：
 *     · 拿不到 parent 的 DOM / window.electronAPI / localStorage（跨源语义）
 *     · 发 postMessage 给父页时 event.origin === 'null'，父页据此只认协议、不认来源特权
 *     · 本地资源（KaTeX / Mermaid / 字体）仍可经绝对 URL 从宿主取
 *
 * 它承担两件事：
 *   1) 整页程序页（<!DOCTYPE html> 段）：直接 document.write 整份 HTML，脚本在**这里**执行。
 *   2) 可信卡片（VCP 卡 + 卡内 <script>）：把卡片 HTML 塞进来，脚本同样在这里执行。
 *      卡片样式由父页注入到本页（卡片视觉与 M1 非可信路径一致），但脚本能力全在这一侧。
 *
 * 与父页的协议（只此两种，父页不认识业务内容）：
 *   父 → 子  { __vcpSandbox: 'document', html, streaming }   整页文档渲染
 *   父 → 子  { __vcpSandbox: 'card', html, css, streaming }  可信卡片渲染
 *   父 → 子  { __vcpSandbox: 'style', css }                  仅注入样式
 *   父 → 子  { __vcpSandbox: 'resize' }                      请求回传高度
 *   子 → 父  { __vcpSandbox: 'height', height }              内容高度变化
 *   子 → 父  { __vcpSandbox: 'input', text }                 卡片 input('…') 交互桥
 *   子 → 父  { __vcpSandbox: 'ready' }                       握手完成
 */
(function () {
  'use strict'

  var HOST = ''
  try {
    // 本页由宿主 http 源提供，用自身 location 推出资源根（不依赖父页传入）
    HOST = window.location.origin
  } catch (e) { /* 取不到按空处理 */ }

  var hostEl = null
  var appliedKeys = {}
  var lastHtml = ''

  /** 收尾：补 <base> 让页内相对链接可解析，并接上高度上报 */
  function ensureHost() {
    if (hostEl) return hostEl
    hostEl = document.createElement('div')
    hostEl.id = 'sandbox-host'
    document.body.appendChild(hostEl)
    return hostEl
  }

  function post(msg) {
    try { parent.postMessage(msg, '*') } catch (e) { /* 父页已卸载，忽略 */ }
  }

  function reportHeight() {
    var h = 0
    try {
      h = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      )
    } catch (e) { /* 文档不可读时用 0 */ }
    post({ __vcpSandbox: 'height', height: h })
  }

  /** 写整页文档：交给浏览器解析整份 HTML，脚本按文档顺序执行 */
  function renderDocument(html) {
    if (typeof html !== 'string') return
    if (html === lastHtml) return
    lastHtml = html
    try {
      document.open()
      document.write(html)
      document.close()
    } catch (e) {
      // document.write 失败（少见）：退回 DOM 注入——脚本不执行，但内容可见
      try {
        ensureHost().innerHTML = html
      } catch (e2) { /* 彻底失败就留白 */ }
    }
    // 文档被重写后 hostEl 引用失效
    hostEl = null
    setTimeout(reportHeight, 0)
    setTimeout(reportHeight, 120)
    setTimeout(reportHeight, 600)
  }

  /**
   * 写可信卡片：薄壳文档 + 卡片 HTML 注入 host 容器。
   * 容器内 <script> 不会因 innerHTML 执行，这里显式提取并按序重排（与上游 trusted 语义
   * 一致：脚本事前被摘出、丢元素留空位，随后统一执行）；差别是——**执行发生在本沙箱内**，
   * 拿不到父页任何东西。
   */
  function renderCard(html, css) {
    if (typeof css === 'string' && css && appliedKeys.css !== css) {
      appliedKeys.css = css
      var st = document.getElementById('sandbox-card-css')
      if (!st) {
        st = document.createElement('style')
        st.id = 'sandbox-card-css'
        document.head.appendChild(st)
      }
      st.textContent = css
    }
    if (typeof html !== 'string') return
    var body = String(html)
    // 摘出 <script>（保留其余 DOM），脚本随后统一执行
    var scripts = []
    body = body.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, function (_m, code) {
      scripts.push(code)
      return ''
    })
    // input('…') 桥归一：改写为 data-vcp-input 属性，由统一委托转交父页。
    // （沙箱内 inline handler 本可自行执行，但把「发送一句话」这条能力收敛到单一入口，
    //   父页只需审一处，无需理解卡里写了什么。）
    body = body.replace(
      /onclick\s*=\s*(["'])\s*input\s*\(\s*(['"])([\s\S]*?)\2\s*\)\s*;?\s*\1/gi,
      function (_m, _q, _q2, text) {
        return 'data-vcp-input="' + String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"'
      }
    )
    var host = ensureHost()
    try { host.innerHTML = body } catch (e) { /* 内容异常时保留已注入部分 */ }
    runScripts(scripts)
    setTimeout(reportHeight, 0)
    setTimeout(reportHeight, 200)
  }

  /** 脚本执行：包一层错误边界，单条失败不牵连后续；执行面仅限本沙箱文档 */
  function runScripts(list) {
    for (var i = 0; i < list.length; i++) {
      try {
        // eslint-disable-next-line no-new-func
        new Function(list[i]).call(window)
      } catch (e) {
        console.error('[vcp-sandbox] 卡内脚本执行失败:', (e && e.message) || e)
      }
    }
  }

  // ── input('…') 交互桥：沙箱内点击 → 上报父页 → 由父页走渲染层的发送通道 ──
  document.addEventListener('click', function (ev) {
    var t = ev.target
    while (t && t !== document.body) {
      var attr = t.getAttribute && t.getAttribute('data-vcp-input')
      if (attr) { post({ __vcpSandbox: 'input', text: attr }); return }
      t = t.parentNode
    }
  }, true)

  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (!d || typeof d !== 'object' || !d.__vcpSandbox) return
    if (d.__vcpSandbox === 'document') renderDocument(d.html)
    else if (d.__vcpSandbox === 'card') renderCard(d.html, d.css)
    else if (d.__vcpSandbox === 'style') renderCard('', d.css)
    else if (d.__vcpSandbox === 'resize') reportHeight()
  })

  // 子文档内的资源（KaTeX/Mermaid/字体）与父页同源策略一致：从宿主绝对 URL 取
  var res = document.createElement('style')
  res.textContent = '@import url("' + HOST + '/vendor/katex-vd.css");'
  document.head.appendChild(res)

  window.addEventListener('load', reportHeight)
  if (window.ResizeObserver) {
    try { new ResizeObserver(reportHeight).observe(document.documentElement) } catch (e) { /* 不支持则退化为定时上报 */ }
  }
  post({ __vcpSandbox: 'ready' })
})()

