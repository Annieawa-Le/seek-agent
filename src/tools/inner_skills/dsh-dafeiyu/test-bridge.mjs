// 事件桥冒烟测试：喂一串 seek-agent 风格的消息，检查产出的协议消息序列。
// 运行：node src/tools/inner_skills/dsh-dafeiyu/test-bridge.mjs

import { CompanionBridge } from './bridge.mjs'

const seen = []
const bridge = new CompanionBridge({
  deliver(messages) {
    for (const m of messages) seen.push(m)
  },
})

const S = 'session-test-1'

function feed(msg) {
  bridge.handle({ ...msg, sessionId: S, sessionName: '测试会话' })
}

function kindsOf(list) {
  return list.map((m) => `${m.kind}${m.state ? ':' + m.state : ''}`)
}

// 1) 一轮开始
feed({ type: 'state', processing: true })
// 2) 思考
feed({ type: 'thinking', active: true })
// 3) 一次读取工具（调用 + 结果）
feed({
  type: 'message', role: 'tool', content: '读取 xxx',
  toolMeta: { toolName: 'read_file', args: { filePath: 'a.ts' } },
  fullOutput: '...content...',
})

// 4) 待办创建：真实格式是挂在 message.rawBulk 上的（不是顶层 todo 事件）
feed({
  type: 'message', role: 'tool', content: '✅ 已创建 todo',
  toolMeta: { toolName: 'create_todo', args: {} },
  fullOutput: '...',
  rawBulk: {
    type: 'todo', action: 'create', name: '写事件桥',
    doneCount: 0, totalCount: 3,
    steps: [
      { content: '摸事件流', completed: false },
      { content: '写事件桥', completed: false },
      { content: '联调', completed: false },
    ],
  },
})

// 4b) 推进一步：第一个未完成变成 in_progress
feed({
  type: 'message', role: 'tool', content: '✅ Step 1 完成',
  toolMeta: { toolName: 'finish_step', args: {} },
  fullOutput: '...',
  rawBulk: {
    type: 'todo', action: 'finish', name: '写事件桥',
    doneCount: 1, totalCount: 3,
    steps: [
      { content: '摸事件流', completed: true },
      { content: '写事件桥', completed: false },
      { content: '联调', completed: false },
    ],
  },
})

// 5) 一次失败的工具结果
feed({
  type: 'message', role: 'tool', content: '命令失败',
  rawBulk: { name: 'run_command', error: 'exit 1' },
})
// 6) 一轮完成
feed({ type: 'state', processing: false })

const states = seen.filter((m) => m.kind === 'state')
const pulses = seen.filter((m) => m.kind === 'pulse')
const tasks = seen.filter((m) => m.kind === 'task')

console.log('== 全部产出 ==')
console.log(kindsOf(seen).join('\n'))

console.log('\n== 断言 ==')
const checks = [
  ['有 state 消息产出', states.length > 0],
  ['出现过 THINKING', states.some((m) => m.state === 'THINKING')],
  ['出现过 WORKING', states.some((m) => m.state === 'WORKING')],
  ['待办推进时出现过 task 消息', tasks.length > 0],
  // 注意：一轮完成时 reducer 走的是 pulse 庆祝 + ttl 后回落 IDLE，
  // 与 DSH 原生行为一致（不是直接发 state），所以这里断言 pulse 而不是末态 state。
  ['轮次结束发成功 pulse', pulses.some((m) => m.state === 'SUCCESS')],
  ['pulse 结束回落到 IDLE', pulses.at(-1)?.resumeState === 'IDLE'],
  ['工具报错发错误 pulse', pulses.some((m) => m.state === 'ERROR')],
  ['文案非空', states.every((m) => typeof m.message === 'string' && m.message.length > 0)],
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) failed += 1
}

if (tasks.length) {
  const t = tasks.at(-1)
  console.log(`\n最近待办文案: ${t.message}`)
  console.log(`进度: ${t.progress?.completed}/${t.progress?.total}`)
  const first = tasks[0]
  console.log(`首次待办进度: ${first.progress?.completed}/${first.progress?.total}`)
}

// todo 专项：确认 rawBulk 里的 todo 真的驱动了进度变化
const progressChecks = [
  ['rawBulk.todo 产出了 task 消息', tasks.length > 0],
  ['进度从 0/3 变成 1/3', tasks[0]?.progress?.completed === 0 && tasks.at(-1)?.progress?.completed === 1],
  ['总步数正确识别为 3', tasks.at(-1)?.progress?.total === 3],
]
console.log('')
for (const [name, ok] of progressChecks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) failed += 1
}
if (states.length) {
  console.log(`\n最终 state.detail: ${states.at(-1).detail}`)
}

process.exit(failed === 0 ? 0 : 1)
