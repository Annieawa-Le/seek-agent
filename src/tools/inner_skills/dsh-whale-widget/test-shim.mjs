/**
 * 假 DSH 宿主自测：加载 dsh-whale-widget、起 HTTP server、喂一轮假对话事件、拉几条路由验证。
 * 用法：node electron/dsh-whale/test-shim.mjs
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createWhaleHost } from './shim.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '.test-data')
await fsp.rm(dataDir, { recursive: true, force: true })

// 显式指定插件的 $DSH_HOME：环境里若已设 DSH_HOME，shim 的兜底不会覆盖它，
// 测试写入的账本/角色配置就会落进真实用户数据目录。
process.env.DSH_HOME = dataDir
const host = createWhaleHost({ widgetDir: path.join(__dirname, 'widget'), dataDir })
await host.loadPlugin()
const { port, injections } = await host.start()
console.log('[test] port =', port)
console.log('[test] injections =', JSON.stringify(injections))
console.log('[test] dataDir =', host.getDataDir())

// 喂一轮假对话（模拟 seek-agent 的一轮：assistant/message(usage) + turn/end）
host.emitSessionEvent({ id: 'test-session', name: '测试对话' }, {
  type: 'assistant/message',
  data: {
    turn: 1,
    usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 },
    message: { source: { model: 'deepseek-flash' } },
  },
})
host.emitSessionEvent({ id: 'test-session' }, { type: 'turn/end', data: { turn: 1 } })
host.emitSessionEvent({ id: 'test-session' }, { type: 'session/title', data: { title: '测试对话' } })

const paths = [
  '/dsh-whale/balance.json',
  '/dsh-whale/size.json',
  '/dsh-whale/audio.json',
  '/dsh-whale/last-turn.json',
  '/dsh-whale/wait.json',
  '/dsh-whale/bubble.json',
  '/dsh-whale/roles.json',
  '/dsh-whale/bubble-imgs.json',
  '/dsh-whale/widget.js',
  '/dsh-whale/image.png',
]
for (const p of paths) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ct = res.headers.get('content-type') || ''
    let preview = ''
    if (ct.includes('json')) preview = buf.toString('utf8').slice(0, 120)
    console.log(`[test] ${p} -> ${res.status} ${ct} ${buf.length}B ${preview}`)
  } catch (err) {
    console.log(`[test] ${p} -> ERR ${err.message}`)
  }
}

// 看一眼账本文件是否生成
try {
  const files = await fsp.readdir(dataDir)
  console.log('[test] data files =', files.join(', '))
} catch (err) {
  console.log('[test] readdir err', err.message)
}

host.dispose()
console.log('[test] done')
process.exit(0)
