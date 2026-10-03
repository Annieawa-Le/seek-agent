/**
 * dsh-worktable 前端（seek-agent 移植版）—— 由 electron/main.js 注入渲染层执行。
 *
 * 与上游（DSH Web 客户端插件）的关键差别：
 *   1. 挂载方式：上游走 @deepseek-ai slot 协议进宿主 React 树，并靠 DOM 锚点把分栏引擎
 *      挤在 DSH 会话区里（0.1.1 / 0.1.2 两套根结构各一套逻辑）。这里不进 React，
 *      纯 DOM 挂载 + MutationObserver 自愈重挂——宿主重渲染把节点冲掉了会自动补回来。
 *   2. 改会话/新建会话：**不直接调 IPC**，而是点宿主自己的侧边栏条目/新建按钮
 *      （DOM 桥）。宿主 App 的会话切换要同时更新标签页、消息流、运行时数据，
 *      绕过它会界面与进程不同步；点它的入口等于复用它自己的那条路径。
 *   3. 数据来源：会话列表/存活进程/当前会话直接用 window.electronAPI（preload 已暴露），
 *      不再像上游那样经宿主会话服务另搭一层适配。
 *
 * 挂载点（两处，均可自愈）：
 *   #left-sidebar 内 → #wt-drawer  工作台项目抽屉
 *   #main-content 内 → #wt-stage   工作台舞台（覆盖主区；M1-b 起改为与宿主会话区并排的分栏）
 *
 * __WT_HOST 由 main.js 注入（本地宿主地址，当前用于健康检查/后续静态托管）。
 */
(function () {
  'use strict'
  if (window.__dshWorktableLoaded) return
  window.__dshWorktableLoaded = true

  const api = window.electronAPI
  if (!api) {
    console.warn('[worktable] 未检测到 electronAPI，前端放弃')
    return
  }
  const HOST = String(window.__WT_HOST || '').replace(/\/+$/, '')
  const log = (...a) => console.log('[worktable]', ...a)

  // ═════════════════════════════════════════════════
  // 常量
  // ═════════════════════════════════════════════════
  const LS_PROJECTS = 'dsh.worktable.projects.v1'
  const LS_VIEW = 'dsh.worktable.view.v1'
  const CONTROL_ROOM_ID = 'control-room'
  const ICONS = ['🗂️', '🖥️', '🧪', '📦', '📝', '🌐', '🎨', '⚙️', '🔧', '📊', '🧭', '🛠️']
  const POLL_MS = 5000
  const REMOUNT_MS = 2000
  const LS_LAYOUTS = 'dsh.worktable.layouts.v1'
  /** 舞台宽度夹紧区间：分栏区不低于 SPLIT_MIN，右侧聊天窗不低于 CHAT_MIN */
  const SPLIT_MIN = 360
  const CHAT_MIN = 320
  /** 单个窗格最小宽度（拖分割条时用） */
  const PANE_MIN = 140

  // ═════════════════════════════════════════════════
  // 小工具
  // ═════════════════════════════════════════════════

  /** 极简 DOM 构造器：h('div', { class:'x', onclick:fn }, 子节点或字符串) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k]
        if (v === null || v === undefined || v === false) continue
        if (k === 'class') el.className = v
        else if (k === 'text') el.textContent = String(v)
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
        else el.setAttribute(k, v === true ? '' : String(v))
      }
    }
    const add = (kid) => {
      if (kid === null || kid === undefined || kid === false) return
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid)
    }
    for (const kid of kids) {
      if (Array.isArray(kid)) for (const k2 of kid) add(k2)
      else add(kid)
    }
    return el
  }

  const uid = () => 'p' + Math.random().toString(36).slice(2, 8)

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return fallback
      const val = JSON.parse(raw)
      return val === null || val === undefined ? fallback : val
    } catch {
      return fallback
    }
  }

  function writeJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val))
    } catch {
      /* 存储被禁用时静默降级为会话内状态 */
    }
  }

  // ═════════════════════════════════════════════════
  // 状态
  // ═════════════════════════════════════════════════
  const defaultProjects = () => [{ id: CONTROL_ROOM_ID, name: '控制室', icon: '🖥️', folder: '', sessionId: '', builtin: true }]

  /** 项目表：内置「控制室」固定存在且不可删除。 */
  function loadProjects() {
    let list = readJSON(LS_PROJECTS, null)
    if (!Array.isArray(list) || list.length === 0) list = defaultProjects()
    if (!list.some((p) => p && p.id === CONTROL_ROOM_ID)) list.unshift(defaultProjects()[0])
    return list.filter((p) => p && p.id)
  }

  let projects = loadProjects()
  let layouts = readJSON(LS_LAYOUTS, {})
  if (!layouts || typeof layouts !== 'object' || Array.isArray(layouts)) layouts = {}
  let view = Object.assign({ open: false, activeId: null }, readJSON(LS_VIEW, {}))
  /** 编辑器状态：null = 关闭；{ mode:'new'|'edit', draft:{id,name,icon,folder,sessionId} } */
  let editor = null
  let sessions = []
  let activeIds = []
  let currentId = null
  let refreshing = false

  const saveProjects = () => writeJSON(LS_PROJECTS, projects)
  const saveView = () => writeJSON(LS_VIEW, view)
  const saveLayouts = () => writeJSON(LS_LAYOUTS, layouts)

  // ═════════════════════════════════════════════════
  // 布局模型
  // ═════════════════════════════════════════════════
  // 行（top 顶行 / main 主行）→ 窗格（横向排列，宽度按比例存 widths）→ 标签页。
  // 控制室默认单窗格（会话卡片网格）；普通项目默认两栏：资源管理器 + 项目信息。

  const PRESETS = [
    { id: 'single', label: '单窗格', top: 0, main: 1 },
    { id: 'main2', label: '左右两栏', top: 0, main: 2 },
    { id: 'main3', label: '三栏', top: 0, main: 3 },
    { id: 'top2main1', label: '顶两窗 + 主一窗', top: 2, main: 1 },
  ]

  function makePane(content) {
    return { id: uid(), tabs: [{ id: uid(), title: '', content: content || { kind: 'picker' } }], active: 0 }
  }

  function defaultLayout(p) {
    if (p.id === CONTROL_ROOM_ID) {
      return {
        preset: 'single',
        splitWidth: 620,
        topHeight: 0.42,
        rows: { top: null, main: { panes: [makePane({ kind: 'console' })], widths: [1] } },
      }
    }
    return {
      preset: 'main2',
      splitWidth: 620,
      topHeight: 0.42,
      rows: {
        top: null,
        main: {
          panes: [makePane({ kind: 'explorer', root: p.folder || '' }), makePane({ kind: 'info' })],
          widths: [0.5, 0.5],
        },
      },
    }
  }

  /** 取项目布局；缺失或结构损坏时重建默认并落盘。 */
  function layoutOf(p) {
    if (!p) return defaultLayout({ id: CONTROL_ROOM_ID })
    const l = layouts[p.id]
    if (!l || !l.rows || !l.rows.main || !Array.isArray(l.rows.main.panes) || l.rows.main.panes.length === 0) {
      const fresh = defaultLayout(p)
      layouts[p.id] = fresh
      saveLayouts()
      return fresh
    }
    if (typeof l.splitWidth !== 'number' || !l.splitWidth) l.splitWidth = 620
    return l
  }

  // ═════════════════════════════════════════════════
  // 宿主数据
  // ═════════════════════════════════════════════════

  /** 单个会话是否在运行（存活进程按 sessionId 匹配）。 */
  const isRunning = (sessionId) => !!(sessionId && activeIds.indexOf(sessionId) >= 0)

  const findSession = (sessionId) => sessions.find((s) => s && (s.sessionId === sessionId || s.name === sessionId)) || null

  /** 会话显示名（与宿主侧边栏的 displayName 规则保持一致）。 */
  const displayNameOf = (s) => (s && (s.title || String(s.name || '').replace(/^session-/, ''))) || ''

  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      const list = await api.listSessions()
      if (Array.isArray(list)) sessions = list
      const act = await api.listActiveSessions()
      if (Array.isArray(act)) activeIds = act.map((x) => x && x.sessionId).filter(Boolean)
      const cur = await api.getCurrentSession()
      if (cur && cur.sessionId) currentId = cur.sessionId
    } catch (err) {
      log('刷新宿主数据失败：', err)
    }
    refreshing = false
    // 编辑器打开时不重建抽屉：会打断正在输入的内容（草稿在 editor.draft 里，
    // 但光标位置与展开状态会丢，不值得为 5 秒一次的轮询付这个代价）。
    // 舞台同理——整树重建会重置资源管理器的滚动位置，所以只在舞台里确实有
    // 「控制室」这种实时内容时才重建它。
    if (!editor) renderDrawer()
    if (view.open && stage && stage.querySelector('.wt-console')) renderStage()
  }

  // ═════════════════════════════════════════════════
  // DOM 桥：复用宿主自己的交互入口
  // ═════════════════════════════════════════════════

  /**
   * 点宿主的会话条目切会话。
   * 会话条目本身不带 id 属性，但 title 是「切换到会话 <显示名>」的确定形态，
   * 按 title 精确匹配即可；匹配不到再退化到显示名文本匹配。
   */
  function clickHostSession(session) {
    const list = document.getElementById('session-list')
    if (!list || !session) return false
    const title = '切换到会话 ' + displayNameOf(session)
    const runningTitles = ['切换到运行中会话 ' + session.sessionId, '切换到运行中会话 ' + session.name]
    const items = list.querySelectorAll('.session-item')
    for (const el of items) {
      const t = el.getAttribute('title') || ''
      if (t === title || runningTitles.indexOf(t) >= 0) {
        el.click()
        return true
      }
    }
    // 退化：显示名文本匹配（标题重复/历史条目缺 title 时）
    const want = displayNameOf(session)
    for (const el of items) {
      const nameEl = el.querySelector('.session-name')
      if (nameEl && (nameEl.textContent || '').trim() === want) {
        el.click()
        return true
      }
    }
    return false
  }

  /** 点宿主自己的「新建会话」按钮（复用它的完整新建流程）。 */
  function clickHostNewSession() {
    const btn = document.getElementById('new-session-btn')
    if (!btn) return false
    btn.click()
    return true
  }

  // ═════════════════════════════════════════════════
  // 渲染
  // ═════════════════════════════════════════════════
  let drawer = null
  let stage = null

  function render() {
    renderDrawer()
    renderStage()
  }

  function renderDrawer() {
    if (!drawer) return
    const list = h('div', { class: 'wt-list' })
    for (const p of projects) {
      list.appendChild(renderCard(p))
      if (editor && editor.mode === 'edit' && editor.draft.id === p.id) list.appendChild(renderEditor())
    }
    if (editor && editor.mode === 'new') list.appendChild(renderEditor())

    drawer.replaceChildren(
      h(
        'div',
        { class: 'wt-head' },
        h('span', { class: 'wt-title' }, '工作台'),
        h(
          'span',
          { class: 'wt-actions' },
          h('button', { class: 'wt-icon-btn', title: '刷新', onclick: () => refresh() }, '⟳'),
          h(
            'button',
            {
              class: 'wt-icon-btn',
              title: '新建项目',
              onclick: () => {
                editor = { mode: 'new', draft: { id: uid(), name: '', icon: '🗂️', folder: '', sessionId: '' } }
                render()
              },
            },
            '＋'
          )
        )
      ),
      list
    )
  }

  function renderCard(p) {
    const bound = findSession(p.sessionId)
    const meta = p.sessionId ? (bound ? displayNameOf(bound) : p.sessionId) : '未绑定会话'
    const active = view.open && view.activeId === p.id
    return h(
      'div',
      { class: 'wt-card' + (active ? ' active' : ''), title: p.folder || '未设置项目文件夹', onclick: () => openProject(p) },
      h('span', { class: 'wt-card-icon' }, p.icon || '🗂️'),
      h('span', { class: 'wt-card-body' }, h('span', { class: 'wt-card-name' }, p.name), h('span', { class: 'wt-card-meta' }, meta)),
      isRunning(p.sessionId) ? h('span', { class: 'wt-dot', title: '该会话正在运行' }) : null,
      h(
        'button',
        {
          class: 'wt-icon-btn wt-card-edit',
          title: '编辑项目',
          onclick: (e) => {
            e.stopPropagation()
            if (editor && editor.draft.id === p.id) editor = null
            else editor = { mode: 'edit', draft: { id: p.id, name: p.name, icon: p.icon, folder: p.folder || '', sessionId: p.sessionId || '' } }
            render()
          },
        },
        '⋯'
      )
    )
  }

  /** 内联编辑器（新建 / 编辑共用）。草稿存 editor.draft，重渲染不会丢输入。 */
  function renderEditor() {
    const d = editor.draft
    const isNew = editor.mode === 'new'
    const nameInput = h('input', {
      class: 'wt-input',
      placeholder: '项目名',
      value: d.name,
      oninput: (e) => {
        d.name = e.target.value
      },
    })
    const folderInput = h('input', {
      class: 'wt-input',
      placeholder: '项目文件夹（可留空）',
      value: d.folder,
      oninput: (e) => {
        d.folder = e.target.value
      },
    })
    const sessionSel = h(
      'select',
      {
        class: 'wt-input',
        onchange: (e) => {
          d.sessionId = e.target.value
        },
      },
      h('option', { value: '' }, '未绑定会话'),
      sessions.map((s) => h('option', { value: s.sessionId || s.name }, displayNameOf(s)))
    )
    sessionSel.value = d.sessionId || ''

    const iconRow = h(
      'div',
      { class: 'wt-icons' },
      ICONS.map((ic) =>
        h(
          'button',
          {
            class: 'wt-icon-pick' + (ic === d.icon ? ' on' : ''),
            onclick: () => {
              d.icon = ic
              render()
            },
          },
          ic
        )
      )
    )

    return h(
      'div',
      { class: 'wt-editor' },
      iconRow,
      nameInput,
      folderInput,
      sessionSel,
      h(
        'div',
        { class: 'wt-editor-actions' },
        h(
          'button',
          {
            class: 'wt-btn primary',
            onclick: () => commitEditor(),
          },
          isNew ? '添加' : '保存'
        ),
        h(
          'button',
          {
            class: 'wt-btn',
            onclick: () => {
              editor = null
              render()
            },
          },
          '取消'
        ),
        !isNew && editor.draft.id !== CONTROL_ROOM_ID
          ? h(
              'button',
              {
                class: 'wt-btn danger',
                onclick: () => removeProject(editor.draft.id),
              },
              '删除'
            )
          : null
      )
    )
  }

  /**
   * 挤法：给宿主主区加左内边距，会话区整体缩窄贴右，左侧空出来给舞台。
   * 不用绝对定位盖住——盖住就把会话挡没了；上游也是靠 margin 挤出来这个思路。
   * 关闭时还原成空串（宿主自己不设 paddingLeft，不留痕迹）。
   */
  function applyShift(p) {
    const main = document.getElementById('main-content')
    if (!main) return
    if (!p || !stage) {
      if (main.style.paddingLeft) main.style.paddingLeft = ''
      return
    }
    const layout = layoutOf(p)
    const w = clampSplitWidth(main, layout.splitWidth)
    if (layout.splitWidth !== w) {
      layout.splitWidth = w
      saveLayouts()
    }
    stage.style.width = w + 'px'
    const px = w + 'px'
    if (main.style.paddingLeft !== px) main.style.paddingLeft = px
  }

  /** 舞台宽度双向夹紧：不小于分栏区下限，也不把聊天窗挤没。 */
  function clampSplitWidth(main, want) {
    const avail = (main && main.clientWidth) || window.innerWidth
    const max = Math.max(SPLIT_MIN, avail - CHAT_MIN)
    return Math.round(Math.max(SPLIT_MIN, Math.min(want || 0, max)))
  }

  function renderStage() {
    if (!stage) return
    const p = projects.find((x) => x.id === view.activeId)
    const open = !!(view.open && p)
    applyShift(open ? p : null)
    if (!open) {
      stage.style.display = 'none'
      return
    }
    stage.style.display = 'flex'
    const layout = layoutOf(p)
    stage.replaceChildren(
      renderStageBar(p, layout),
      h('div', { class: 'wt-stage-body' }, renderRows(p, layout)),
      renderStageResizer(p, layout)
    )
  }

  function renderStageBar(p, layout) {
    const sub = p.id === CONTROL_ROOM_ID ? '所有会话的实时状态' : p.folder || '未设置项目文件夹'
    const sel = h(
      'select',
      { class: 'wt-select', title: '布局预设' },
      PRESETS.map((ps) => h('option', { value: ps.id }, ps.label))
    )
    sel.value = layout.preset
    sel.addEventListener('change', () => {
      applyPreset(layout, sel.value)
      saveLayouts()
      renderStage()
    })
    return h(
      'div',
      { class: 'wt-stage-bar' },
      h('span', { class: 'wt-stage-icon' }, p.icon || '🗂️'),
      h('span', { class: 'wt-stage-name' }, p.name),
      h('span', { class: 'wt-stage-sub' }, sub),
      h('span', { class: 'wt-spacer' }),
      sel,
      h('button', { class: 'wt-icon-btn', title: '刷新', onclick: () => refresh() }, '⟳'),
      h('button', { class: 'wt-icon-btn', title: '关闭工作台（会话区还原）', onclick: () => closeStage() }, '✕')
    )
  }

  /** 切换预设：按预设数量补/裁窗格，宽度重新均分（已有窗格与标签保留）。 */
  function applyPreset(layout, presetId) {
    const def = PRESETS.find((x) => x.id === presetId) || PRESETS[1]
    layout.preset = def.id
    layout.rows.main = fitRow(layout.rows.main, def.main)
    layout.rows.top = def.top > 0 ? fitRow(layout.rows.top || { panes: [], widths: [] }, def.top) : null
  }

  function fitRow(row, count) {
    const panes = (row.panes || []).slice(0, count)
    while (panes.length < count) panes.push(makePane({ kind: 'picker' }))
    const widths = []
    for (let i = 0; i < count; i++) widths.push(1 / count)
    return { panes, widths }
  }

  /** 控制室：会话卡片网格（镜像宿主会话运行时状态，不调用模型）。 */
  function renderConsole() {
    const cards = sessions.map((s) => {
      const running = isRunning(s.sessionId) || isRunning(s.name)
      const isCurrent = currentId && (currentId === s.sessionId || currentId === s.name)
      const time = s.timestamp ? new Date(s.timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
      return h(
        'div',
        {
          class: 'wt-sess-card' + (running ? ' running' : '') + (isCurrent ? ' current' : ''),
          title: '切换到该会话',
          onclick: () => {
            clickHostSession(s)
            closeStage()
          },
        },
        h(
          'div',
          { class: 'wt-sess-head' },
          h('span', { class: 'wt-sess-title' }, displayNameOf(s) || s.name),
          h('span', { class: 'wt-sess-state' + (running ? ' running' : '') }, isCurrent ? '当前' : running ? '工作中' : '空闲')
        ),
        h('div', { class: 'wt-sess-meta' }, (s.messageCount || 0) + ' msgs' + (time ? ' · ' + time : '')),
        h('div', { class: 'wt-sess-prev' }, s.preview || '（无预览）')
      )
    })

    const alive = activeIds.filter((id) => !sessions.some((s) => s.sessionId === id || s.name === id))

    return h(
      'div',
      { class: 'wt-console' },
      h(
        'div',
        { class: 'wt-console-bar' },
        h('span', { class: 'wt-console-count' }, sessions.length + ' 个会话 · ' + activeIds.length + ' 个进程存活'),
        h('button', { class: 'wt-btn', onclick: () => clickHostNewSession() }, '＋ 新建会话')
      ),
      cards.length === 0 && alive.length === 0
        ? h('div', { class: 'wt-empty' }, '暂无会话')
        : h('div', { class: 'wt-grid' }, cards.concat(alive.map((id) => h('div', { class: 'wt-sess-card running' }, h('div', { class: 'wt-sess-head' }, h('span', { class: 'wt-sess-title' }, id), h('span', { class: 'wt-sess-state running' }, '工作中')), h('div', { class: 'wt-sess-meta' }, '运行中（未保存）'))))),
    )
  }

  // ═════════════════════════════════════════════════
  // 分栏：行 → 窗格 → 标签 → 内容
  // ═════════════════════════════════════════════════

  function renderRows(p, layout) {
    const wrap = h('div', { class: 'wt-rows' })
    if (layout.rows.top) {
      const el = renderRow(p, layout, 'top')
      el.classList.add('wt-row-top')
      el.style.flexBasis = Math.round((layout.topHeight || 0.42) * 100) + '%'
      wrap.appendChild(el)
    }
    wrap.appendChild(renderRow(p, layout, 'main'))
    return wrap
  }

  function renderRow(p, layout, key) {
    const row = layout.rows[key]
    const el = h('div', { class: 'wt-row' })
    row.panes.forEach((pane, i) => {
      if (i > 0) el.appendChild(renderSplitter(layout, key, i - 1))
      el.appendChild(renderPane(p, layout, key, i))
    })
    return el
  }

  /** 窗格：标签栏（含新建/关闭）+ 内容区。宽度用 flexGrow 存比例。 */
  function renderPane(p, layout, key, index) {
    const row = layout.rows[key]
    const pane = row.panes[index]
    if (!pane) return h('div')
    const el = h('div', { class: 'wt-pane' })
    el.style.flexGrow = String(Math.max(0.05, row.widths[index] || 1))
    el.style.flexBasis = '0'

    const tabs = h('div', { class: 'wt-pane-tabs' })
    pane.tabs.forEach((tab, ti) => {
      const label = tabTitle(tab)
      const tabEl = h(
        'div',
        { class: 'wt-tab' + (ti === pane.active ? ' on' : ''), title: label },
        h('span', { class: 'wt-tab-label' }, label),
        pane.tabs.length > 1 ? h('span', { class: 'wt-tab-x', title: '关闭标签' }, '✕') : null
      )
      tabEl.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('wt-tab-x')) {
          pane.tabs.splice(ti, 1)
          pane.active = Math.max(0, Math.min(pane.active, pane.tabs.length - 1))
        } else {
          pane.active = ti
        }
        saveLayouts()
        renderStage()
      })
      tabs.appendChild(tabEl)
    })
    tabs.appendChild(
      h('button', { class: 'wt-tab-add', title: '在当前窗格新开标签', onclick: () => addPaneTab(p, key, index) }, '＋')
    )
    if (row.panes.length > 1) {
      tabs.appendChild(h('button', { class: 'wt-tab-add', title: '关闭窗格', onclick: () => removePane(key, index) }, '−'))
    }

    el.appendChild(tabs)
    el.appendChild(h('div', { class: 'wt-pane-body' }, renderPaneContent(p, key, index)))
    return el
  }

  /** 标签标题：优先 tab.title（文件标签用文件名），否则按内容类型给名。 */
  function tabTitle(tab) {
    const c = tab.content || {}
    if (tab.title) return tab.title
    if (c.kind === 'console') return '控制室'
    if (c.kind === 'explorer') return '资源管理器'
    if (c.kind === 'info') return '项目信息'
    if (c.kind === 'file') return String(c.path || '').split(/[\\/]/).pop() || '文件'
    return '未指派'
  }

  function renderPaneContent(p, key, index) {
    const pane = layoutOf(p).rows[key].panes[index]
    const tab = pane && pane.tabs[pane.active]
    if (!tab) return h('div', { class: 'wt-empty' }, '空窗格')
    const c = tab.content || { kind: 'picker' }
    if (c.kind === 'console') return renderConsole()
    if (c.kind === 'explorer') return renderExplorer(p, c)
    if (c.kind === 'file') return renderFileView(c)
    if (c.kind === 'info') return renderInfo(p)
    return renderPicker(p, (content) => setPaneContent(p, key, index, content))
  }

  /** 指派内容类型后清掉自定义标题，让 tabTitle 按内容类型命名。 */
  function setPaneContent(p, key, index, content) {
    const pane = layoutOf(p).rows[key].panes[index]
    const tab = pane && pane.tabs[pane.active]
    if (!tab) return
    tab.content = content
    tab.title = ''
    saveLayouts()
    renderStage()
  }

  function addPaneTab(p, key, index) {
    const pane = layoutOf(p).rows[key].panes[index]
    if (!pane) return
    pane.tabs.push({ id: uid(), title: '', content: { kind: 'picker' } })
    pane.active = pane.tabs.length - 1
    saveLayouts()
    renderStage()
  }

  function removePane(key, index) {
    const layout = layoutOf(projects.find((x) => x.id === view.activeId))
    const row = layout && layout.rows[key]
    if (!row || row.panes.length <= 1) return
    row.panes.splice(index, 1)
    row.widths.splice(index, 1)
    saveLayouts()
    renderStage()
  }

  // ── 窗格内容：类型选择器 ──

  const CONTENT_KINDS = [
    { kind: 'explorer', icon: '🗂️', label: '资源管理器', hint: '浏览项目文件夹，点文件即开只读预览' },
    { kind: 'info', icon: 'ℹ️', label: '项目信息', hint: '项目文件夹与绑定的会话' },
    { kind: 'console', icon: '🖥️', label: '控制室', hint: '所有会话的实时运行状态' },
  ]

  function renderPicker(p, choose) {
    const grid = h('div', { class: 'wt-picker' })
    for (const k of CONTENT_KINDS) {
      grid.appendChild(
        h(
          'button',
          { class: 'wt-picker-btn', title: k.hint, onclick: () => choose(kindContent(p, k.kind)) },
          h('span', { class: 'wt-picker-icon' }, k.icon),
          h('span', { class: 'wt-picker-label' }, k.label)
        )
      )
    }
    return h('div', { class: 'wt-picker-wrap' }, h('div', { class: 'wt-picker-title' }, '这个窗口显示什么'), grid)
  }

  function kindContent(p, kind) {
    if (kind === 'explorer') return { kind: 'explorer', root: p.folder || '' }
    return { kind }
  }

  function renderInfo(p) {
    const bound = findSession(p.sessionId)
    return h(
      'div',
      { class: 'wt-info' },
      h('div', { class: 'wt-info-row' }, h('span', { class: 'wt-info-key' }, '项目文件夹'), h('span', { class: 'wt-info-val' }, p.folder || '（未设置）')),
      h('div', { class: 'wt-info-row' }, h('span', { class: 'wt-info-key' }, '绑定会话'), h('span', { class: 'wt-info-val' }, bound ? displayNameOf(bound) : p.sessionId || '（未绑定）')),
      h('div', { class: 'wt-info-hint' }, '在左栏「工作台」卡片上点 ⋯ 可编辑项目；绑定会话后，打开项目会自动切到那个会话。')
    )
  }

  // ── 窗格内容：资源管理器 ──

  /** 目录内容缓存：5 秒轮询会重建舞台，缓存能让重建不反复打 IPC。 */
  const dirCache = new Map()
  /** 已展开的目录绝对路径（重建后据此还原展开态）。 */
  const treeOpen = new Set()

  async function lsNodes(dir) {
    if (dirCache.has(dir)) return dirCache.get(dir)
    let nodes = []
    try {
      const r = await api.readFileTree(dir)
      if (Array.isArray(r)) nodes = r
      else if (r && r.error) log('列目录失败：', dir, r.error)
    } catch (err) {
      log('列目录异常：', dir, err)
    }
    dirCache.set(dir, nodes)
    return nodes
  }

  function renderExplorer(p, content) {
    const root = content.root || p.folder || ''
    const box = h('div', { class: 'wt-explorer' })
    if (!root) {
      box.appendChild(h('div', { class: 'wt-empty' }, '项目未设置文件夹：在左栏卡片上点 ⋯ 填绝对路径'))
      return box
    }
    box.appendChild(
      h(
        'div',
        { class: 'wt-explorer-path', title: root },
        h('span', { class: 'wt-explorer-root' }, root),
        h('button', { class: 'wt-icon-btn', title: '重新读取目录', onclick: () => { dirCache.clear(); renderStage() } }, '⟳')
      )
    )
    const list = h('div', { class: 'wt-tree' })
    box.appendChild(list)
    void fillTree(list, root, 0)
    return box
  }

  /** 按 treeOpen 还原展开态；已被缓存的目录同步出内容，未缓存的异步补上。 */
  async function fillTree(container, dir, depth) {
    const nodes = await lsNodes(dir)
    const frag = document.createDocumentFragment()
    for (const n of nodes) {
      frag.appendChild(treeRow(n, depth))
      if (n.type === 'folder' && treeOpen.has(n.absPath)) {
        const sub = h('div', { class: 'wt-tree-children' })
        frag.appendChild(sub)
        void fillTree(sub, n.absPath, depth + 1)
      }
    }
    container.replaceChildren(frag)
  }

  function treeRow(node, depth) {
    const isDir = node.type === 'folder'
    const open = isDir && treeOpen.has(node.absPath)
    const row = h(
      'div',
      { class: 'wt-tree-row' + (isDir ? ' dir' : ''), title: node.absPath, style: { paddingLeft: 6 + depth * 12 + 'px' } },
      h('span', { class: 'wt-tree-icon' }, isDir ? (open ? '📂' : '📁') : '📄'),
      h('span', { class: 'wt-tree-name' }, node.name)
    )
    row.addEventListener('click', () => {
      if (isDir) {
        if (open) treeOpen.delete(node.absPath)
        else treeOpen.add(node.absPath)
        renderStage()
      } else {
        openFileTab(node.absPath)
      }
    })
    return row
  }

  /** 文件标签开在「有资源管理器的窗格」里，没有就落在第一个窗格。 */
  function openFileTab(absPath) {
    const p = projects.find((x) => x.id === view.activeId)
    if (!p) return
    const layout = layoutOf(p)
    const panes = layout.rows.main.panes.concat(layout.rows.top ? layout.rows.top.panes : [])
    const target =
      panes.find((pane) => pane.tabs.some((t) => t.content && t.content.kind === 'explorer')) || panes[0]
    if (!target) return
    const title = String(absPath).split(/[\\/]/).pop()
    const exist = target.tabs.findIndex((t) => t.content && t.content.kind === 'file' && t.content.path === absPath)
    if (exist >= 0) {
      target.active = exist
    } else {
      target.tabs.push({ id: uid(), title, content: { kind: 'file', path: absPath } })
      target.active = target.tabs.length - 1
    }
    saveLayouts()
    renderStage()
  }

  // ── 窗格内容：文件预览 ──

  /** 文件内容缓存：同上，避免轮询重建时反复读盘与闪烁。 */
  const fileCache = new Map()

  function renderFileView(content) {
    const box = h('div', { class: 'wt-fileview' })
    if (!content.path) {
      box.appendChild(h('div', { class: 'wt-empty' }, '未指定文件'))
      return box
    }
    box.appendChild(h('div', { class: 'wt-fileview-path', title: content.path }, content.path))
    const body = h('pre', { class: 'wt-fileview-body' })
    box.appendChild(body)

    const cached = fileCache.get(content.path)
    if (cached) {
      paintFile(body, cached)
      return box
    }
    body.textContent = '加载中…'
    void (async () => {
      const r = await api.readFile(content.path)
      const entry = r && r.ok ? { content: r.content || '' } : { error: (r && r.error) || '未知错误' }
      fileCache.set(content.path, entry)
      if (body.isConnected) paintFile(body, entry)
    })()
    return box
  }

  function paintFile(body, entry) {
    body.textContent = entry.error ? '打开失败：' + entry.error : entry.content
    body.classList.toggle('err', !!entry.error)
  }

  // ── 拖拽：舞台宽度 / 窗格宽度 ──

  /** 舞台右边缘：拖出分栏区与聊天窗的宽度比。 */
  function renderStageResizer(p, layout) {
    const bar = h('div', { class: 'wt-stage-resizer', title: '拖动调整分栏宽度' })
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const main = document.getElementById('main-content')
      const startX = e.clientX
      const startW = layout.splitWidth
      const move = (ev) => {
        const w = clampSplitWidth(main, startW + (ev.clientX - startX))
        layout.splitWidth = w
        if (stage) stage.style.width = w + 'px'
        if (main) main.style.paddingLeft = w + 'px'
      }
      const up = () => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.userSelect = ''
        saveLayouts()
        renderStage()
      }
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
    return bar
  }

  /** 窗格之间的分割条：拖动只改 flexGrow，松手才落盘。 */
  function renderSplitter(layout, key, leftIndex) {
    const row = layout.rows[key]
    const bar = h('div', { class: 'wt-vsplit', title: '拖动调整窗格宽度' })
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const rowEl = bar.parentElement
      const total = rowEl ? rowEl.clientWidth : 0
      if (!total) return
      const startX = e.clientX
      const a0 = row.widths[leftIndex] || 0.5
      const b0 = row.widths[leftIndex + 1] || 0.5
      const sum = a0 + b0
      const leftPx = (total * a0) / sum
      const move = (ev) => {
        const next = Math.max(PANE_MIN, Math.min(leftPx + (ev.clientX - startX), total - PANE_MIN))
        const na = (next / total) * sum
        row.widths[leftIndex] = na
        row.widths[leftIndex + 1] = sum - na
        applyRowWidths(rowEl, row)
      }
      const up = () => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.userSelect = ''
        saveLayouts()
      }
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
    return bar
  }

  function applyRowWidths(rowEl, row) {
    const panes = Array.prototype.filter.call(rowEl.children, (el) => el.classList && el.classList.contains('wt-pane'))
    panes.forEach((el, i) => {
      el.style.flexGrow = String(Math.max(0.05, row.widths[i] || 1))
    })
  }

  // ═════════════════════════════════════════════════
  // 交互
  // ═════════════════════════════════════════════════

  /** 打开项目：切到绑定会话（走宿主入口），并展开舞台。 */
  function openProject(p) {
    view.open = true
    view.activeId = p.id
    saveView()
    render()
    if (p.sessionId) {
      const s = findSession(p.sessionId)
      if (s) clickHostSession(s)
      else log('绑定会话不在宿主列表中，跳过切换：', p.sessionId)
    }
  }

  function closeStage() {
    view.open = false
    saveView()
    render()
  }

  function commitEditor() {
    const d = editor.draft
    const name = (d.name || '').trim()
    if (!name) {
      log('项目名不能为空')
      return
    }
    const exist = projects.find((p) => p.id === d.id)
    if (exist) {
      exist.name = name
      exist.icon = d.icon
      exist.folder = (d.folder || '').trim()
      exist.sessionId = d.sessionId || ''
    } else {
      projects.push({ id: d.id, name, icon: d.icon, folder: (d.folder || '').trim(), sessionId: d.sessionId || '' })
    }
    saveProjects()
    editor = null
    render()
  }

  function removeProject(id) {
    projects = projects.filter((p) => p.id !== id || p.builtin)
    if (view.activeId === id) {
      view.open = false
      view.activeId = null
      saveView()
    }
    saveProjects()
    editor = null
    render()
  }

  // ═════════════════════════════════════════════════
  // 挂载与自愈
  // ═════════════════════════════════════════════════

  function buildShell() {
    drawer = h('div', { id: 'wt-drawer' })
    stage = h('div', { id: 'wt-stage' })
    stage.style.display = 'none'
  }

  /** 宿主重渲染会重建侧边栏/主区子节点，把我们挂的节点冲掉——这里补回来。 */
  function ensureMounted() {
    const sidebar = document.getElementById('left-sidebar')
    if (sidebar && drawer && !sidebar.contains(drawer)) {
      const spacer = sidebar.querySelector('#sidebar-spacer')
      if (spacer) sidebar.insertBefore(drawer, spacer)
      else sidebar.appendChild(drawer)
    }
    const main = document.getElementById('main-content')
    if (main && stage && stage.parentElement !== main) main.appendChild(stage)
    // 宿主重渲染可能重置主区样式；舞台开着就重新夹一次宽度（幂等，值没变时不写 DOM）
    if (main && view.open) applyShift(projects.find((x) => x.id === view.activeId) || null)
    else if (main && main.style.paddingLeft) main.style.paddingLeft = ''
  }

  let mountScheduled = false
  function scheduleMountCheck() {
    if (mountScheduled) return
    mountScheduled = true
    requestAnimationFrame(() => {
      mountScheduled = false
      ensureMounted()
    })
  }

  function watchHost() {
    // 自愈：宿主 React 一动就检查一次（rAF 合并），外加低频兜底轮询防漏事件
    try {
      new MutationObserver(scheduleMountCheck).observe(document.body, { childList: true, subtree: true })
    } catch {
      /* 环境不支持时靠轮询兜底 */
    }
    setInterval(ensureMounted, REMOUNT_MS)
    // 窗口缩放要把分栏宽度重新夹一遍，否则会一直用旧宽度顶到聊天窗
    window.addEventListener('resize', () => {
      if (view.open) applyShift(projects.find((x) => x.id === view.activeId) || null)
    })
  }

  // ═════════════════════════════════════════════════
  // 样式
  // ═════════════════════════════════════════════════
  const CSS = `
/* 工作台舞台走绝对定位覆盖主区，主区需要定位上下文 */
#main-content { position: relative; }

#wt-drawer { border-top: 1px solid var(--border-color, rgba(128,128,128,0.25)); padding: 8px 8px 10px; }
#wt-drawer .wt-head { display: flex; align-items: center; padding: 2px 4px 8px; }
#wt-drawer .wt-title { flex: 1; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted, #8e8ea0); }
#wt-drawer .wt-actions { display: flex; gap: 2px; }
.wt-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
  padding: 0; border: none; border-radius: 5px; background: transparent; color: var(--text-muted, #8e8ea0);
  font-size: 12px; line-height: 1; cursor: pointer; font-family: inherit; }
.wt-icon-btn:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); color: var(--text-primary, #eee); }

#wt-drawer .wt-list { display: flex; flex-direction: column; gap: 4px; }
.wt-card { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
  border: 1px solid transparent; cursor: pointer; user-select: none; }
.wt-card:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); }
.wt-card.active { border-color: var(--accent, #d4a843); background: var(--accent-bg, rgba(212,168,67,0.1)); }
.wt-card-icon { width: 20px; text-align: center; font-size: 15px; flex-shrink: 0; }
.wt-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wt-card-name { font-size: 13px; color: var(--text-primary, #eee); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-card-meta { font-size: 11px; color: var(--text-muted, #8e8ea0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-card-edit { opacity: 0; }
.wt-card:hover .wt-card-edit { opacity: 1; }
.wt-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent, #d4a843); flex-shrink: 0; }

.wt-editor { display: flex; flex-direction: column; gap: 6px; padding: 8px; margin: 2px 0 6px;
  border: 1px solid var(--border-color, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--bg-hover, rgba(255,255,255,0.04)); }
.wt-icons { display: flex; flex-wrap: wrap; gap: 3px; }
.wt-icon-pick { width: 24px; height: 24px; padding: 0; border: 1px solid transparent; border-radius: 6px;
  background: transparent; font-size: 13px; cursor: pointer; }
.wt-icon-pick:hover { background: var(--bg-hover, rgba(255,255,255,0.08)); }
.wt-icon-pick.on { border-color: var(--accent, #d4a843); background: var(--accent-bg, rgba(212,168,67,0.12)); }
.wt-input { width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: 12px; font-family: inherit;
  color: var(--text-primary, #eee); background: var(--bg-base, #17161a);
  border: 1px solid var(--border-color, rgba(128,128,128,0.3)); border-radius: 6px; outline: none; }
.wt-input:focus { border-color: var(--accent, #d4a843); }
.wt-editor-actions { display: flex; gap: 6px; }
.wt-btn { padding: 4px 10px; font-size: 12px; font-family: inherit; cursor: pointer; border-radius: 6px;
  border: 1px solid var(--border-color, rgba(128,128,128,0.3)); background: transparent; color: var(--text-secondary, #ccc); }
.wt-btn:hover { background: var(--bg-hover, rgba(255,255,255,0.08)); color: var(--text-primary, #eee); }
.wt-btn.primary { border-color: var(--accent, #d4a843); color: var(--accent, #d4a843); }
.wt-btn.danger:hover { border-color: #e05252; color: #e05252; }

/* 舞台贴主区左侧，宽度由 JS 按「夹紧后的分栏宽度」写入 style.width；
   右侧那条缝留给宿主会话区（靠主区的 padding-left 挤出来） */
#wt-stage { position: absolute; left: 0; top: 0; bottom: 0; width: 620px; z-index: 30;
  display: flex; flex-direction: column; background: var(--bg-base, #17161a);
  border-right: 1px solid var(--border-color, rgba(128,128,128,0.25)); }
.wt-stage-bar { display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 38px; flex-shrink: 0;
  border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.25)); }
.wt-stage-icon { font-size: 15px; }
.wt-stage-name { font-size: 13px; font-weight: 600; color: var(--text-primary, #eee); }
.wt-stage-sub { font-size: 11px; color: var(--text-muted, #8e8ea0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-spacer { flex: 1; }
.wt-stage-hint { font-size: 11px; color: var(--text-muted, #8e8ea0); }
.wt-stage-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }

.wt-console { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.wt-console-bar { display: flex; align-items: center; gap: 10px; }
.wt-console-count { flex: 1; font-size: 12px; color: var(--text-muted, #8e8ea0); }
.wt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.wt-sess-card { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--border-color, rgba(128,128,128,0.25)); background: var(--bg-hover, rgba(255,255,255,0.03)); }
.wt-sess-card:hover { border-color: var(--accent, #d4a843); }
.wt-sess-card.current { border-color: var(--accent, #d4a843); background: var(--accent-bg, rgba(212,168,67,0.1)); }
.wt-sess-head { display: flex; align-items: center; gap: 8px; }
.wt-sess-title { flex: 1; min-width: 0; font-size: 13px; color: var(--text-primary, #eee);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-sess-state { font-size: 10px; padding: 1px 6px; border-radius: 8px; flex-shrink: 0;
  color: var(--text-muted, #8e8ea0); background: var(--bg-hover, rgba(255,255,255,0.06)); }
.wt-sess-state.running { color: var(--accent, #d4a843); background: var(--accent-bg, rgba(212,168,67,0.12)); }
.wt-sess-meta { font-size: 11px; color: var(--text-muted, #8e8ea0); }
.wt-sess-prev { font-size: 11px; color: var(--text-secondary, #ccc); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.wt-empty { padding: 14px; font-size: 12px; color: var(--text-muted, #8e8ea0);
  border: 1px dashed var(--border-color, rgba(128,128,128,0.25)); border-radius: 10px; }

/* ── 分栏：行 / 窗格 / 拖拽条 ── */
.wt-rows { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 6px; }
.wt-row { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }
.wt-row-top { flex: 0 0 auto; }
.wt-vsplit { flex: 0 0 6px; width: 6px; border-radius: 3px; cursor: col-resize; }
.wt-vsplit:hover { background: var(--accent-bg, rgba(212,168,67,0.18)); }
.wt-stage-resizer { position: absolute; right: -3px; top: 0; bottom: 0; width: 6px; z-index: 2; cursor: col-resize; }
.wt-stage-resizer:hover { background: var(--accent-bg, rgba(212,168,67,0.18)); }
.wt-select { padding: 2px 6px; font-size: 12px; font-family: inherit; border-radius: 6px; outline: none;
  border: 1px solid var(--border-color, rgba(128,128,128,0.3)); background: var(--bg-base, #17161a); color: var(--text-secondary, #ccc); }

.wt-pane { display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  border: 1px solid var(--border-color, rgba(128,128,128,0.25)); border-radius: 8px; }
.wt-pane-tabs { display: flex; align-items: center; gap: 2px; flex-shrink: 0; padding: 3px 4px;
  border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.25)); overflow-x: auto; }
.wt-tab { display: flex; align-items: center; gap: 4px; max-width: 180px; padding: 3px 8px; border-radius: 6px;
  font-size: 12px; color: var(--text-muted, #8e8ea0); cursor: pointer; user-select: none; }
.wt-tab:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); }
.wt-tab.on { background: var(--bg-hover, rgba(255,255,255,0.08)); color: var(--text-primary, #eee); }
.wt-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-tab-x { font-size: 10px; opacity: 0; }
.wt-tab:hover .wt-tab-x { opacity: 0.7; }
.wt-tab-add { width: 18px; height: 18px; flex-shrink: 0; padding: 0; border: none; border-radius: 5px;
  background: transparent; color: var(--text-muted, #8e8ea0); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit; }
.wt-tab-add:hover { background: var(--bg-hover, rgba(255,255,255,0.08)); color: var(--text-primary, #eee); }
.wt-pane-body { flex: 1; min-height: 0; min-width: 0; overflow: auto; }

/* ── 窗格内容：类型选择器 ── */
.wt-picker-wrap { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.wt-picker-title { font-size: 12px; color: var(--text-muted, #8e8ea0); }
.wt-picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.wt-picker-btn { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 8px;
  border: 1px solid var(--border-color, rgba(128,128,128,0.25)); border-radius: 10px; background: transparent;
  color: var(--text-secondary, #ccc); font-family: inherit; font-size: 12px; cursor: pointer; }
.wt-picker-btn:hover { border-color: var(--accent, #d4a843); color: var(--text-primary, #eee); }
.wt-picker-icon { font-size: 20px; }

/* ── 窗格内容：资源管理器 ── */
.wt-explorer { display: flex; flex-direction: column; min-height: 100%; }
.wt-explorer-path { display: flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 5px 8px;
  border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.25)); font-size: 11px; color: var(--text-muted, #8e8ea0); }
.wt-explorer-root { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; direction: rtl; text-align: left; }
.wt-tree { padding: 4px 0; }
.wt-tree-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px;
  font-size: 12px; color: var(--text-secondary, #ccc); cursor: pointer; white-space: nowrap; }
.wt-tree-row:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); color: var(--text-primary, #eee); }
.wt-tree-icon { width: 14px; flex-shrink: 0; text-align: center; font-size: 11px; }
.wt-tree-name { overflow: hidden; text-overflow: ellipsis; }

/* ── 窗格内容：文件预览（只读） ── */
.wt-fileview { display: flex; flex-direction: column; min-height: 100%; }
.wt-fileview-path { flex-shrink: 0; padding: 5px 8px; font-size: 11px; color: var(--text-muted, #8e8ea0);
  border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.25));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-fileview-body { margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.55; white-space: pre;
  font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace); color: var(--text-secondary, #ccc); }
.wt-fileview-body.err { color: #e05252; }

/* ── 窗格内容：项目信息 ── */
.wt-info { display: flex; flex-direction: column; gap: 8px; padding: 14px; }
.wt-info-row { display: flex; gap: 10px; font-size: 12px; }
.wt-info-key { width: 72px; flex-shrink: 0; color: var(--text-muted, #8e8ea0); }
.wt-info-val { color: var(--text-secondary, #ccc); word-break: break-all; }
.wt-info-hint { margin-top: 4px; font-size: 11px; line-height: 1.6; color: var(--text-muted, #8e8ea0); }
`

  function injectStyle() {
    if (document.getElementById('wt-style')) return
    const el = document.createElement('style')
    el.id = 'wt-style'
    el.textContent = CSS
    document.head.appendChild(el)
  }

  // ═════════════════════════════════════════════════
  // 启动
  // ═════════════════════════════════════════════════
  /**
   * 布局模型自检：把纯逻辑路径在真实渲染层里跑一遍（不依赖任何点击操作），
   * 结果打到控制台——主进程会把渲染层 console 转发到 stdout，于是能远程看到。
   */
  function selfCheckLayouts() {
    try {
      const probe = { id: '__probe__', name: 'probe', folder: '' }
      const l = defaultLayout(probe)
      const start = l.rows.main.panes.length
      applyPreset(l, 'main3')
      const three = l.rows.main.panes.length
      applyPreset(l, 'top2main1')
      const top = l.rows.top ? l.rows.top.panes.length : 0
      const main = l.rows.main.panes.length
      applyPreset(l, 'main2')
      const back = l.rows.main.panes.length
      const w = clampSplitWidth(null, 99999)

      // 挤法实测：借控制室槽位真跑一遍 applyShift，读回实测值后立刻还原。
      // 全过程同步完成、不产生绘制帧，界面不会闪；也不留任何状态。
      const savedRoom = layouts[CONTROL_ROOM_ID]
      let shift = '未测'
      try {
        const room = projects.find((x) => x.id === CONTROL_ROOM_ID) || { id: CONTROL_ROOM_ID, name: '控制室', folder: '' }
        layouts[CONTROL_ROOM_ID] = l
        applyShift(room)
        const mainEl = document.getElementById('main-content')
        shift = '分栏 ' + ((stage && stage.style.width) || '?') + ' / 会话区左内边距 ' + ((mainEl && mainEl.style.paddingLeft) || '0')
      } finally {
        applyShift(null)
        if (savedRoom === undefined) delete layouts[CONTROL_ROOM_ID]
        else layouts[CONTROL_ROOM_ID] = savedRoom
        // applyShift 内部会落盘探测结果，还原后再写一次盖回去，别留脏数据
        saveLayouts()
      }

      return (
        '布局自检：默认 ' + start + ' 栏 → 三栏 ' + three + ' → 顶两窗+主一窗 ' + top + '+' + main +
        ' → 回两栏 ' + back + ' · 宽度夹紧上限 ' + w + 'px · 挤法实测 ' + shift
      )
    } catch (err) {
      return '布局自检失败：' + ((err && err.message) || err)
    }
  }

  function boot() {
    injectStyle()
    buildShell()
    ensureMounted()
    watchHost()
    render()
    setInterval(refresh, POLL_MS)
    // 会话连接状态变化即刷新（事件驱动；轮询只作为兜底）
    try {
      api.onAgentStatus(() => refresh())
    } catch {
      /* 无该事件时靠轮询 */
    }
    // 自检回执：宿主重渲染会不断重建侧边栏/主区子节点，这里把「确实挂上去了」这件事打出来，
    // 免得只能靠肉眼看界面判断（渲染层控制台日志由主进程转发到 stdout）
    refresh().then(() => {
      const sidebar = document.getElementById('left-sidebar')
      const main = document.getElementById('main-content')
      log(
        '已挂载：抽屉' + (sidebar && sidebar.contains(drawer) ? '在侧边栏内' : '未定位到侧边栏') +
          ' / 舞台' + (stage && stage.parentElement === main ? '在主区内' : '未定位到主区') +
          ' / 项目 ' + projects.length + ' 个 / 会话 ' + sessions.length + ' 个 / 宿主 ' + (HOST || '(未注入)')
      )
      const ap = view.open ? projects.find((x) => x.id === view.activeId) : null
      if (ap) {
        const l = layoutOf(ap)
        log(
          '舞台：' + ap.name + ' · 预设 ' + l.preset +
            ' · 窗格 ' + l.rows.main.panes.length + (l.rows.top ? '+' + l.rows.top.panes.length : '') +
            ' · 分栏 ' + l.splitWidth + 'px · 会话区左内边距 ' + ((main && main.style.paddingLeft) || '0')
        )
      }
      log(selfCheckLayouts())
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
