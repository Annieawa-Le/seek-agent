/**
 * 用量桥接口径自检。
 *
 * 背景：seek-agent 推的 usage 是**会话累计值**（同一轮里每个 LLM 步骤都会把"截止到现在的
 * 总量"再推一次），而插件按「每条 assistant/message = 一次调用」自己往上加。两者直接对接
 * 会把账算成天文数字。本脚本用真宿主跑两个对照：
 *   A 直接转发累计值（旧行为）—— 一轮账目 = Σ累计，随步骤数膨胀
 *   B 经 usage-cursor 换算成增量（现行为）—— 一轮账目 = 该轮真实用量
 * 运行：node src/tools/inner_skills/dsh-whale-widget/test-usage-bridge.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createWhaleHost } from './shim.mjs'
import { createUsageCursor } from './usage-cursor.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const checks = []
const check = (name, ok) => checks.push([name, ok])

// 同一轮三次 LLM 调用，seek-agent 侧推送的是累计四桶（最后一条 = 该轮真实总量）
const ROUND = [
  { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 },
  { inputTokens: 3000, cacheReadTokens: 500, cacheWriteTokens: 100, outputTokens: 400 },
  { inputTokens: 6000, cacheReadTokens: 900, cacheWriteTokens: 300, outputTokens: 700 },
]
// 该轮真实用量（tokens 口径 = 未缓存输入 + 缓存写 + 缓存读 + 输出）
const REAL_TOKENS = 6300 + 900 + 700

// ── A. 换算单元：累计 → 增量 ──
const cursor = createUsageCursor()
const S = 'unit'
const steps = ROUND.map((u) => cursor.take(S, u))
check('首步按全量记（此前没基线）', steps[0].inputTokens === 1000 && steps[0].outputTokens === 200)
check('第二步只记增量（cacheWrite 并入输入）', steps[1].inputTokens === 2100 && steps[1].cacheReadTokens === 500)
check('第三步只记增量', steps[2].inputTokens === 3200 && steps[2].cacheReadTokens === 400 && steps[2].outputTokens === 300)
const summed = steps.reduce((a, x) => ({
  inputTokens: a.inputTokens + x.inputTokens,
  cacheReadTokens: a.cacheReadTokens + x.cacheReadTokens,
  outputTokens: a.outputTokens + x.outputTokens,
}), { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })
check('三步合计 = 该轮真实总量（输入 6300 / 缓存读 900 / 输出 700）',
  summed.inputTokens === 6300 && summed.cacheReadTokens === 900 && summed.outputTokens === 700)
check('数值没变时返回 null（不发空事件）', cursor.take(S, ROUND[2]) === null)
const afterReset = cursor.take(S, { inputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 })
check('累计值回落（agent 进程重启）时基线重置，按新用量计',
  afterReset.inputTokens === 800 && afterReset.outputTokens === 100)

// ── B. 端到端：真宿主记账对照 ──
const dataDir = path.join(here, '.test-data-usage')
await fsp.rm(dataDir, { recursive: true, force: true })
// 插件的账本落在 $DSH_HOME。开发机上若已设了 DSH_HOME，shim 的兜底不会覆盖它，
// 账本就会写进真实用户数据目录 —— 这里显式指到测试目录，确保自检不碰真数据。
process.env.DSH_HOME = dataDir
const host = createWhaleHost({ widgetDir: path.join(here, 'widget'), dataDir })
await host.loadPlugin()
await host.start()

/** 一轮：若干条 assistant/message + turn/end（与 main.js 的桥接序列一致） */
function feedTurn(sessionId, turn, usageList) {
  for (const usage of usageList) {
    host.emitSessionEvent({ id: sessionId, name: '自检会话' }, {
      type: 'assistant/message',
      data: { turn, usage, message: { source: { model: 'deepseek-flash' } } },
    })
  }
  host.emitSessionEvent({ id: sessionId }, { type: 'turn/end', data: { turn } })
}

const ledgerEvents = () => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, '.dshw-usage.json'), 'utf8')).events || [] }
  catch { return [] }
}

// A 组：旧行为，累计值原样转发
feedTurn('sess-old', 1, ROUND)
const oldTurn = ledgerEvents().at(-1)
check('旧接法会把累计值重复累加（账目 = Σ 每条累计）', oldTurn?.tokens === 1200 + 3900 + 7600)

// B 组：现行为，先经 cursor 换算成增量再转发
const bridgeCursor = createUsageCursor()
feedTurn('sess-new', 2, ROUND.map((u) => bridgeCursor.take('sess-new', u)).filter(Boolean))
const newTurn = ledgerEvents().at(-1)
check(`新接法账目 = 该轮真实用量（${REAL_TOKENS}）`, newTurn?.tokens === REAL_TOKENS)
check('新接法账目比旧接法小且不虚高', (newTurn?.tokens || 0) < (oldTurn?.tokens || 0))

host.dispose()

console.log('== 用量桥接口径 ==')
console.log(`旧接法本轮 tokens: ${oldTurn?.tokens}   （该轮真实是 ${REAL_TOKENS}）`)
console.log(`新接法本轮 tokens: ${newTurn?.tokens}`)
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) failed += 1
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed ? 1 : 0)
