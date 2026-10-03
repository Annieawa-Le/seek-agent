/**
 * dsh-meme 前端（DOM hack 版）—— 注入 seek-agent 渲染层执行。
 *
 * 与鲸鱼娘 widget.js 同类：不走任何宿主 API，直接操作 DOM。相比原 client.js，
 * 「挂载方式」重写，「核心算法」照搬：
 *   - 消息装饰：把 .message .content 里的 [表情: 描述] 换成 <img>
 *   - 输入框 😊 面板：点选把 [表情: 描述] 插进输入框
 *   - 复用：g/非g 双正则、caption 三级匹配 + 分词兜底、ghost 防回环、去重、防抖 + maxWait
 * __MEME_HOST 由 main.js 注入（宿主地址，如 http://127.0.0.1:12345）。
 */
(function () {
  'use strict'
  if (window.__dshMemeLoaded) return
  window.__dshMemeLoaded = true

  const HOST = String(window.__MEME_HOST || '').replace(/\/+$/, '')
  if (!HOST) { console.warn('[dsh-meme] 未注入 __MEME_HOST，前端放弃'); return }
  const log = (...a) => console.log('[dsh-meme]', ...a)

  // ===== 正则：exec 用 g 版；test 必须用非 g 版（g 版 test 会推进 lastIndex，原插件踩过）=====
  const MEME_RE = /\[表情:\s*([^\]]+)\](?:\((https?:\/\/[^\s)]+)\))?/g
  const MEME_TEST = /\[表情:\s*([^\]]+)\](?:\((https?:\/\/[^\s)]+)\))?/

  // ===== caption 归一化（照搬原 client.js）=====
  const foldCaption = (s) => String(s || '').replace(/[“”‘’「」『』«»]/g, '"').replace(/\s+/g, ' ').trim()
  const looseCaption = (s) => foldCaption(s).replace(/["'\s]/g, '')
  function splitDescTokens(desc) {
    return String(desc || '')
      .split(/[\s,，、;；/|:：!！?？.。()（）\[\]【】"'“”‘’]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .sort((a, b) => b.length - a.length)
  }

  // ===== 索引（caption/keywords → 图片 URL）=====
  let index = null
  let hayRows = null
  let indexLoading = false
  let indexRetryAt = 0

  function addKey(map, key, url) {
    const k = String(key || '').trim()
    if (!k) return
    for (const v of [k, foldCaption(k), looseCaption(k)]) if (v && !map.has(v)) map.set(v, url)
  }

  function buildIndex(rows) {
    const map = new Map()
    const hays = []
    for (const r of rows) {
      const rel = r.url || (r.path ? '/dsh-memes/' + r.path : '')
      if (!rel) continue
      const url = HOST + rel
      addKey(map, r.caption, url)
      addKey(map, r.file_name, url)
      addKey(map, r.keywords, url)
      if (r.caption) addKey(map, String(r.caption).slice(0, 80), url)
      hays.push({
        hay: ((r.tag || '') + ' ' + (r.caption || '') + ' ' + (r.keywords || '') + ' ' + (r.file_name || '')).toLowerCase(),
        url,
      })
    }
    index = map
    hayRows = hays
    log('索引就绪：', map.size, '个 key /', hays.length, '张图')
  }

  function loadIndex() {
    if (index || indexLoading || Date.now() < indexRetryAt) return
    indexLoading = true
    fetch(HOST + '/dsh-memes-api?packId=all')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((res) => buildIndex((res && res.memes) || []))
      .catch((e) => { indexRetryAt = Date.now() + 5000; console.warn('[dsh-meme] 索引加载失败，5s 后重试:', e && e.message) })
      .finally(() => { indexLoading = false })
  }

  /** 描述 → 图片 URL：三级精确命中 → 分词兜底（模型偶尔不抄原文）。 */
  function matchDesc(desc) {
    if (!index) return null
    const raw = String(desc || '').trim()
    if (!raw) return null
    const exact = index.get(raw) || index.get(foldCaption(raw)) || index.get(looseCaption(raw))
    if (exact) return exact
    for (const token of splitDescTokens(raw)) {
      const needle = token.toLowerCase()
      for (const row of hayRows) if (row.hay.includes(needle)) return row.url
    }
    return null
  }

  // ===== 样式 =====
  const CSS = `
    .dshm-picker-btn{position:absolute;right:8px;bottom:8px;width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;font-size:16px;line-height:1;opacity:.65;padding:0;}
    .dshm-picker-btn:hover{opacity:1;background:rgba(127,127,127,.18);}
    .dshm-board{position:fixed;display:none;z-index:99999;width:440px;max-width:90vw;max-height:340px;overflow:auto;background:rgba(30,30,32,.98);border:1px solid rgba(127,127,127,.4);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.5);padding:10px;}
    .dshm-board-head{font-size:12px;opacity:.65;margin:0 0 8px 2px;}
    .dshm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:8px;}
    .dshm-cell{width:74px;height:74px;border-radius:8px;background-size:cover;background-position:center;cursor:pointer;background-color:rgba(127,127,127,.14);}
    .dshm-cell:hover{outline:2px solid #4a9eff;}
  `
  function injectStyle() {
    if (document.getElementById('dshm-style')) return
    const el = document.createElement('style')
    el.id = 'dshm-style'
    el.textContent = CSS
    document.head.appendChild(el)
  }

  // ===== 消息装饰 =====
  const ghostFor = (text) => {
    const s = document.createElement('span')
    s.dataset.memeHidden = '1'
    s.style.display = 'none'
    s.textContent = text
    return s
  }

  function decorateText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement
        if (!el) return NodeFilter.FILTER_REJECT
        const content = el.closest('.content')
        if (!content || !content.closest('.message')) return NodeFilter.FILTER_REJECT
        // 流式中不装饰：React 每帧重设 innerHTML，装饰会被打回而闪烁，等流式结束再补
        if (el.closest('.message.streaming')) return NodeFilter.FILTER_REJECT
        if (el.closest('pre, code, textarea, input, [data-meme-hidden], [data-meme-decorated]')) return NodeFilter.FILTER_REJECT
        return MEME_TEST.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    const targets = []
    let n
    while ((n = walker.nextNode())) targets.push(n)

    for (const node of targets) {
      const text = node.nodeValue || ''
      MEME_RE.lastIndex = 0
      let m
      let last = 0
      let changed = false
      const frag = document.createDocumentFragment()
      while ((m = MEME_RE.exec(text))) {
        const desc = m[1]
        const url = (m[2] && /^https?:/.test(m[2])) ? m[2] : matchDesc(desc)
        if (last < m.index) frag.appendChild(document.createTextNode(text.slice(last, m.index)))
        if (url) {
          const img = document.createElement('img')
          img.src = url
          img.dataset.memeImg = foldCaption(desc)
          img.style.cssText = 'max-width:160px;max-height:160px;border-radius:10px;display:block;margin:6px 0'
          frag.appendChild(img)
          frag.appendChild(ghostFor(m[0]))   // 藏原文，保证 textContent 逐字不变（防第三方插件回环）
          changed = true
        } else {
          frag.appendChild(document.createTextNode(m[0]))
        }
        last = m.index + m[0].length
      }
      if (!changed) continue
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
      const parent = node.parentElement
      if (!parent) continue
      parent.replaceChild(frag, node)
      parent.dataset.memeDecorated = '1'
    }
  }

  /** 流式重渲染可能把同一处装饰两次 → 按「内容容器 + 描述」去重。 */
  let seq = 0
  function dedupe() {
    const seen = new Set()
    for (const img of document.querySelectorAll('img[data-meme-img]')) {
      const box = img.closest('.content') || img.parentElement
      if (!box) continue
      if (!box.__dshmKey) box.__dshmKey = ++seq
      const key = box.__dshmKey + '|' + img.dataset.memeImg
      if (seen.has(key)) {
        const g = img.nextSibling
        if (g && g.nodeType === 1 && g.dataset && g.dataset.memeHidden) g.remove()
        img.remove()
      } else seen.add(key)
    }
  }

  // ===== 扫描调度：防抖 300ms + maxWait 1200ms + 重入保护 =====
  const SCAN_DEBOUNCE = 300
  const SCAN_MAX_WAIT = 1200
  let scanTimer = 0
  let scanDeadline = 0
  let scanning = false

  function runScan() {
    if (scanning) return
    scanning = true
    try {
      loadIndex()
      decorateText()
      dedupe()
    } catch (e) {
      console.warn('[dsh-meme] 装饰失败:', e)
    } finally {
      scanning = false
    }
  }

  function scheduleScan() {
    const now = Date.now()
    if (!scanDeadline) scanDeadline = now + SCAN_MAX_WAIT
    clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      scanDeadline = 0
      runScan()
    }, Math.max(0, Math.min(SCAN_DEBOUNCE, scanDeadline - now)))
  }

  // ===== 输入框 😊 面板 =====
  function setTextareaValue(ta, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  let board = null
  function ensureBoard() {
    if (board) return board
    board = document.createElement('div')
    board.className = 'dshm-board'
    board.innerHTML = '<div class="dshm-board-head">表情包</div><div class="dshm-grid">加载中…</div>'
    document.body.appendChild(board)
    document.addEventListener('pointerdown', (e) => {
      const t = e.target
      if (board && !board.contains(t) && !(t.closest && t.closest('.dshm-picker-btn'))) board.style.display = 'none'
    })
    return board
  }

  function openBoard(anchor, ta) {
    const el = ensureBoard()
    const rect = anchor.getBoundingClientRect()
    el.style.display = 'block'
    el.style.left = Math.max(8, rect.left - 8) + 'px'
    el.style.bottom = (window.innerHeight - rect.top + 8) + 'px'

    const grid = el.querySelector('.dshm-grid')
    grid.textContent = '加载中…'
    fetch(HOST + '/dsh-memes-api?packId=all')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((res) => {
        const memes = (res && res.memes) || []
        grid.innerHTML = ''
        if (!memes.length) { grid.textContent = '图库为空'; return }
        for (const m of memes) {
          const cell = document.createElement('div')
          cell.className = 'dshm-cell'
          cell.title = m.caption || m.file_name || ''
          cell.style.backgroundImage = 'url(' + HOST + (m.url || '/dsh-memes/' + m.path) + ')'
          cell.addEventListener('click', () => {
            const desc = String(m.caption || m.keywords || m.tag || '表情包').slice(0, 80)
            const text = '[表情: ' + desc + ']'
            const cur = ta.value || ''
            setTextareaValue(ta, cur.trim() ? cur.replace(/\s*$/, '') + '\n' + text : text)
            ta.focus()
            el.style.display = 'none'
          })
          grid.appendChild(cell)
        }
      })
      .catch(() => { grid.textContent = '加载失败' })
  }

  function mountPicker() {
    const ta = document.querySelector('.input-wrapper textarea, textarea')
    if (!ta) return
    if (document.querySelector('.dshm-picker-btn')) return
    const box = ta.closest('.input-wrapper') || ta.parentElement
    if (!box) return
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative'
    const btn = document.createElement('button')
    btn.className = 'dshm-picker-btn'
    btn.type = 'button'
    btn.title = '表情包'
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M8.2 14.2s1.4 1.9 3.8 1.9 3.8-1.9 3.8-1.9"/><line x1="9.2" y1="9.3" x2="9.21" y2="9.3"/><line x1="14.8" y1="9.3" x2="14.81" y2="9.3"/></svg>'
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openBoard(btn, ta) })
    box.appendChild(btn)
    log('输入框面板已挂载')
  }

  // ===== 启动 =====
  injectStyle()
  const observer = new MutationObserver(() => scheduleScan())
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })

  const boot = () => { runScan(); mountPicker() }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
  setInterval(mountPicker, 3000)   // 输入框可能随会话切换重建
})()
