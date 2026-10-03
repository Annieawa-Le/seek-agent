// 桌宠窗口生命周期自检：用假 BrowserWindow 跑 createPetHost，
// 验证「开窗 → 关窗 → 重开」这条契约 —— electron/main.js 关主窗时正是靠
// petHost.close() 收掉这条鱼，关不干净它就会一直挂在桌面上、应用也退不出去。
// 运行：node src/tools/inner_skills/dsh-dafeiyu/test-window.mjs

import { createPetHost } from './pet-window.js'

const windows = []

class FakeWebContents {
  constructor() { this.sent = [] }
  on() {}
  send(channel, payload) { this.sent.push({ channel, payload }) }
}

class FakeWindow {
  constructor(opts) {
    this.opts = opts
    this.handlers = new Map()
    this.webContents = new FakeWebContents()
    this.alive = true
    this.showCalls = 0
    windows.push(this)
  }
  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, [])
    this.handlers.get(evt).push(fn)
  }
  once(evt, fn) { this.on(evt, fn) }
  emit(evt, ...args) { for (const fn of this.handlers.get(evt) || []) fn(...args) }
  async loadFile() {}
  showInactive() { this.showCalls += 1 }
  isDestroyed() { return !this.alive }
  destroy() { this.alive = false; this.emit('closed') }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setBounds() {}
  setPosition() {}
  getPosition() { return [100, 100] }
  getSize() { return [240, 300] }
}

/** 构造函数显式返回对象：new FakeBrowserWindow(...) 拿到的就是 FakeWindow 实例 */
function FakeBrowserWindow(opts) {
  return new FakeWindow(opts)
}

const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }

const checks = []
function check(name, ok) { checks.push([name, ok]) }

const host = createPetHost({ BrowserWindow: FakeBrowserWindow, screen })

const opened = await host.open()
check('open() 返回成功', opened === true)
check('isOpen() 为真', host.isOpen() === true)
check('创建了 1 个窗口', windows.length === 1)

windows[0].emit('ready-to-show')
check('窗口就绪后 showInactive 被调用', windows[0].showCalls === 1)

await host.open()
check('重复 open() 不新建窗口', windows.length === 1)

host.close()
check('close() 后 isOpen() 为假', host.isOpen() === false)
check('close() 真的销毁了窗口', windows[0].isDestroyed() === true)

let threw = false
try { host.close() } catch { threw = true }
check('close() 幂等（重复调用不抛错）', threw === false)

const reopened = await host.open()
check('关闭后可重开（macOS activate 走的路径）', reopened === true && host.isOpen() === true)
check('重开创建了新窗口', windows.length === 2 && windows[1].isDestroyed() === false)

// 窗口被外部销毁（渲染进程崩掉 / 将来加窗内退出入口）时，宿主不能还攥着死窗口
windows[1].destroy()
check('窗口被外部销毁后 isOpen() 归假', host.isOpen() === false)

// ── 配置合并语义：复刻真实启动时序 ──
// open() → 下发持久化配置 → ready-to-show 补推。补推若按「缺省即默认值」逐项填，
// 会把刚下发的 speed 冲回 1（表现为重启后动作速度永远是 1.0 倍）。
const host2 = createPetHost({ BrowserWindow: FakeBrowserWindow, screen })
await host2.open()
const pet = windows.at(-1)
const lastConfigPayload = () => pet.webContents.sent.filter((m) => m.channel === 'dafeiyu:config').at(-1)?.payload

pet.webContents.sent.length = 0
host2.applyConfig({ scale: 0.8, speed: 1.5, bubbleMode: 'custom', playbackFps: 90 })
pet.emit('ready-to-show')
const pushed = lastConfigPayload()
check('就绪补推不会把动作速度冲回 1.0', pushed?.speed === 1.5)
check('就绪补推不会把气泡模式冲回默认', pushed?.bubbleMode === 'custom')
check('就绪补推不会把刷新帧率冲回默认', pushed?.playbackFps === 90)
check('就绪补推仍带上尺寸相关字段', pushed?.scale === 0.8 && pushed?.bubbleSpace > 0)

// 设置面板只改一项时，其余字段也要沿用（增量 patch 语义）
pet.webContents.sent.length = 0
host2.applyConfig({ reducedMotion: true })
const patched = lastConfigPayload()
check('单项 patch 只改该项', patched?.reducedMotion === true)
check('单项 patch 不冲掉其它字段', patched?.speed === 1.5 && patched?.bubbleScale === 1)

console.log('== 桌宠窗口生命周期 ==')
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) failed += 1
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed ? 1 : 0)

