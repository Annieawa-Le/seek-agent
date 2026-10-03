// 大肥鱼桌宠的 Electron 侧：透明置顶窗 + 事件桥接线。
//
// 这个模块由 electron/main.js 调用，本身不 import electron —— BrowserWindow
// 由宿主传入，方便在没有 Electron 的环境里单独跑逻辑测试。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 角色基准尺寸（manifest.baseSize 会覆盖） */
const DEFAULT_WINDOW = { width: 240, height: 300 }
/** 位置持久化与窗体贴合的安全边距 */
const EDGE_MARGIN = 8
/** 气泡留白基准（scale=1 时窗口顶部给气泡留的高度） */
const BUBBLE_BASE = 72

async function loadManifest() {
  try {
    const raw = readFileSync(join(here, 'assets', 'pet-manifest.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 创建一个桌宠宿主。
 * @param {object} opts
 * @param {Function} opts.BrowserWindow  Electron 的 BrowserWindow 构造器
 * @param {Function} opts.screen          Electron 的 screen 模块（用于贴边定位）
 * @param {boolean}  [opts.reducedMotion] 是否减少动态
 */
export function createPetHost({ BrowserWindow, screen, reducedMotion = false, status: statusArg } = {}) {
  let win = null
  let bridge = null
  // 缓存的 manifest：缩放变化时需要重算窗口尺寸（帧尺寸来自这里）
  let cachedManifest = null
  let layout = { x: null, y: null, scale: 1 }
  // 已下发的配置。合并语义：多次 applyConfig 按字段叠加（见方法内注释）
  let config = { reducedMotion }
  // 拖拽过程中不写盘（mousemove 频率很高），抬手或窗口 moved 后才落盘
  let dragDirty = false
  // 状态收集器可选：没传就退化成一个空壳，不影响桌宠本身运行
  const status = statusArg ?? {
    markOpened() {}, markPageLoaded() {}, markAssets() {}, markMessage() {}, markError() {},
  }

  const layoutPath = join(here, 'layout.json')

  function loadLayout() {
    try {
      const raw = JSON.parse(readFileSync(layoutPath, 'utf8'))
      if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) {
        layout.x = raw.x
        layout.y = raw.y
      }
      if (Number.isFinite(raw?.scale)) layout.scale = Math.min(1.4, Math.max(0.55, raw.scale))
    } catch { /* 首次运行没有布局文件，用默认右下角 */ }
  }

  function saveLayout() {
    try {
      mkdirSync(here, { recursive: true })
      writeFileSync(layoutPath, JSON.stringify(layout, null, 2), 'utf8')
    } catch (err) {
      console.error('[dafeiyu] 布局保存失败：', err)
    }
  }

  /** 默认位置：工作区右下角 */
  function defaultPosition(width, height) {
    const area = screen?.getPrimaryDisplay?.()?.workArea
    if (!area) return { x: 1200, y: 600 }
    return {
      x: area.x + area.width - width - EDGE_MARGIN * 2,
      y: area.y + area.height - height - EDGE_MARGIN * 2,
    }
  }



  /**
   * 窗口尺寸 = 角色帧尺寸 × scale + 顶部气泡留白（也随 scale 收）。
   *
   * 尺寸链路只允许一处缩放：窗口按 scale 建小，页面里图片 1:1 铺满，
   * 不再叠加 CSS transform —— 早期两边都乘 scale，缩放生效两次（0.6² = 0.36），
   * 鱼被缩得极小、窗口本身却仍是原尺寸，四周留出大片"看不见但能拖"的空白。
   *
   * 气泡留白 = 窗口顶部给气泡的高度。气泡顶住窗口上沿向下排布，
   * 占多少算多少，因此这里给的是「上限」而非「必须留满」。
   * 按带 detail 的常见气泡高（约 48–60px）取 72px 基准，随 scale 收但不低于 56px。
   */
  function currentBounds(manifest) {
    const scale = layout.scale || 1
    const fw = Number(manifest?.maxFrameWidth) || Number(manifest?.baseSize) || DEFAULT_WINDOW.width
    const fh = Number(manifest?.maxFrameHeight) || DEFAULT_WINDOW.height
    const width = Math.round(fw * scale)
    const bubbleSpace = Math.max(56, Math.round(BUBBLE_BASE * scale))
    const height = Math.round(fh * scale) + bubbleSpace
    return { width, height, bubbleSpace }
  }

  /** 把主进程收到的协议消息推给桌宠窗 */
  function deliver(messages) {
    if (!win || win.isDestroyed()) return
    const flat = Array.isArray(messages) ? messages : [messages]
    const tasks = flat.find((m) => m?.kind === 'tasks')
    const single = flat.filter((m) => m?.kind !== 'tasks')
    for (const msg of single) {
      status.markMessage(msg)
      win.webContents.send('dafeiyu:message', msg)
    }
    if (tasks) win.webContents.send('dafeiyu:tasks', tasks.tasks || [])
  }

  return {
    /** 懒加载事件桥（依赖 lib/ 下的 reducer） */
    async initBridge() {
      if (bridge) return bridge
      const { CompanionBridge } = await import(pathToFileURL(join(here, 'bridge.mjs')).href)
      bridge = new CompanionBridge({ deliver })
      return bridge
    },

    getBridge() {
      return bridge
    },

    /** 打开桌宠窗；已存在则仅聚焦 */
    async open() {
      if (win && !win.isDestroyed()) {
        win.showInactive()
        return true
      }
      if (typeof BrowserWindow !== 'function') {
        console.error('[dafeiyu] 缺少 BrowserWindow，无法创建桌宠窗口')
        return false
      }

      const manifest = await loadManifest()
      cachedManifest = manifest
      loadLayout()
      const bounds = currentBounds(manifest)
      if (layout.x === null || layout.y === null) {
        const pos = defaultPosition(bounds.width, bounds.height)
        layout.x = pos.x
        layout.y = pos.y
      }

      win = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        x: Math.round(layout.x),
        y: Math.round(layout.y),
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: join(here, 'pet-preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          // 页面从 file:// 加载，素材也在本地磁盘，无需放开 webSecurity
          webSecurity: true,
        },
      })

      // 置顶到普通窗口之上，但不盖住系统级浮层
      win.setAlwaysOnTop(true, 'floating')
      // 桌宠窗独立于主窗口，转发它的 console 到主进程 stdout，否则窗内报错看不见
      win.webContents.on('console-message', (event) => {
        console.log(`[dafeiyu:${event.level}] ${event.message}`);
      });
      if (typeof win.setVisibleOnAllWorkspaces === 'function') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      }

      // pet.html 里的素材基址占位符换成本地 file:// 前缀。
      // 用 file:// 直接加载页面（而不是 data: URL），页面与素材同源，
      // fetch(manifest) 与 <img src="file://..."> 都不会被同源策略拦。
      const base = pathToFileURL(join(here, 'assets') + '/').href
      const html = readFileSync(join(here, 'pet.html'), 'utf8').replaceAll('PET_ASSET_BASE_PLACEHOLDER', base)
      const runtimePath = join(here, 'pet.runtime.html')
      writeFileSync(runtimePath, html, 'utf8')
      await win.loadFile(runtimePath)

      win.webContents.on('did-finish-load', () => {
        console.log('[dafeiyu] 桌宠页面已加载')
        status.markPageLoaded()
      })
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        console.error(`[dafeiyu] 桌宠页面加载失败 ${code}: ${desc}`)
        status.markError(`页面加载失败 ${code}: ${desc}`)
      })
      win.webContents.on('render-process-gone', (_e, details) => {
        console.error('[dafeiyu] 桌宠渲染进程退出：', details?.reason)
        status.markError(`渲染进程退出：${details?.reason}`)
      })
      status.markAssets(Object.keys(manifest?.clips || {}).length, null)

      win.once('ready-to-show', () => {
        win.showInactive()
        console.log('[dafeiyu] 桌宠窗口已显示')
        status.markOpened()
        // 窗口就绪后补推一次配置：传空 patch 重发前面已合并的完整配置，
        // 而不是只带 scale/reducedMotion 的新配置（后者会把 speed 等冲回默认）
        this.applyConfig({})
      })

      // 手动拖拽（dragMove）也会触发 moved；拖拽中记位置但不写盘，
      // 等 dragEnd 统一落盘，避免每秒几十次文件写入。
      win.on('moved', () => {
        if (!win || win.isDestroyed()) return
        const [x, y] = win.getPosition()
        layout.x = x
        layout.y = y
        if (!dragDirty) saveLayout()
      })

      win.on('closed', () => { win = null })
      return true
    },

    /** 把最新配置下发给窗内页面 */
    applyConfig(patch = {}) {
      if (!win || win.isDestroyed()) return
      // 合并而非替换：applyConfig 会被调用多次（启动下发持久化配置、设置面板增量 patch、
      // 窗口就绪时补推），后一次常常只带部分字段 —— 若按 next 逐项填默认值，
      // 就会把先前设好的速度/气泡等冲回默认（表现为重启后动作速度总是 1.0 倍）。
      config = { ...config, ...patch }
      const prevScale = layout.scale || 1
      if (Number.isFinite(config.scale)) layout.scale = Math.min(1.4, Math.max(0.55, config.scale))

      // scale 变了 → 窗口必须跟着改尺寸（缩放由窗口尺寸实现，页面里 1:1）。
      // 以「右下角锚定」重设，避免缩放后桌宠从原位置跳走。
      if (layout.scale !== prevScale) {
        const bounds = currentBounds(cachedManifest)
        const [x, y] = win.getPosition()
        const [ow, oh] = win.getSize()
        layout.x = x + (ow - bounds.width)
        layout.y = y + (oh - bounds.height)
        win.setBounds({ x: Math.round(layout.x), y: Math.round(layout.y), width: bounds.width, height: bounds.height })
        saveLayout()
      }

      const bounds = currentBounds(cachedManifest)
      win.webContents.send('dafeiyu:config', {
        scale: layout.scale || 1,
        // 气泡留白量：页面用它算角色区高度，必须和窗口尺寸用同一套算法
        bubbleSpace: bounds.bubbleSpace,
        // 动画播放倍率（1 = 素材原速）。和 playbackFps 是两回事：
        // speed 改动作快慢，playbackFps 只决定换帧时机能有多准。
        speed: Number(config.speed) > 0 ? Number(config.speed) : 1,
        bubbleScale: config.bubbleScale ?? 1,
        activityLevel: config.activityLevel ?? 'normal',
        reducedMotion: config.reducedMotion === true,
        soundEnabled: config.soundEnabled !== false,
        bubbleMode: config.bubbleMode ?? 'always',
        bubbleStates: Array.isArray(config.bubbleStates) ? config.bubbleStates : ['SUCCESS', 'ERROR', 'WAITING'],
        // 帧率上限（默认 60）。素材本身是 42ms/帧（约 23.8fps）录制的，
        // 这个值只决定「换帧时机的精度上限」，不改变动作快慢。
        playbackFps: Number(config.playbackFps) > 0 ? Number(config.playbackFps) : 60,
      })
    },

    /** 从布局里取当前缩放（设置面板回显用） */
    getScale() {
      return layout.scale || 1
    },

    setScale(scale) {
      this.applyConfig({ scale: Number(scale) || 1 })
    },

    /**
     * 按增量位移移动窗口。由窗内 mousemove 驱动 —— 比 -webkit-app-region
     * 更跟手（app-region 有系统级延迟），也不会吃掉点击事件。
     */
    dragMove(dx, dy) {
      if (!win || win.isDestroyed()) return
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
      const [x, y] = win.getPosition()
      const nx = Math.round(x + dx)
      const ny = Math.round(y + dy)
      win.setPosition(nx, ny)
      layout.x = nx
      layout.y = ny
      dragDirty = true
    },

    /** 拖拽结束：落盘位置（拖动过程中不写盘，避免高频 IO） */
    dragEnd() {
      dragDirty = false
      saveLayout()
    },

    isOpen() {
      return !!(win && !win.isDestroyed())
    },

    close() {
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    },
  }
}

export { here as petSkillDir }


