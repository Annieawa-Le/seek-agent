// seek-agent 事件 → DSH session/event 的桥接层。
//
// companion-reducer.js 是按 DSH 的事件词汇表写的（turn/start、tool/call、
// tool/result、todo/write、turn/end…）。seek-agent 用的是另一套消息（state、
// message role:tool、tool-call…），所以本文件负责翻译，reducer 本身不做改动。
//
// 设计要点：
// - 一个 seek-agent 会话映射成一个 DSH session 对象；reducer 只用到
//   id / cwd / title / header.origin 这几个字段。
// - seek-agent 的 tool 消息把「调用」和「结果」压在同一条里，这里按有无
//   toolMeta 判定是调用、有无 rawBulk 判定是结果，拆成两个事件。
// - 事件必须带递增 seq：reducer 用 seq 做文案轮换的种子，缺了会退化成固定文案。

import { CompanionReducer } from './lib/companion-reducer.js'

/** 工具名 → reducer 的 activity 分类用到的原名即可，reducer 自己会归类 */
function toolNameOf(msg) {
  return msg?.toolMeta?.toolName
    || msg?.rawBulk?.name
    || msg?.rawBulk?.toolName
    || ''
}

/**
 * seek-agent 的 todo 数据 → reducer 的 todo/write 载荷。
 *
 * 两边字段不同：
 *   seek-agent: { name, doneCount, totalCount, steps: [{ content, completed: bool }] }
 *   reducer:    [{ content, status: 'pending' | 'in_progress' | 'completed' }]
 *
 * 转换规则：把「第一个未完成」标为 in_progress（seek-agent 没有显式进行中概念，
 * 但 finish_step 是按顺序推进的，所以第一个未完成就是当前步），其余保持原状。
 */
function todosToReducerSteps(rawBulk) {
  const raw = Array.isArray(rawBulk?.steps) ? rawBulk.steps : []
  if (raw.length) {
    let markedInProgress = false
    return raw.map((step) => {
      const done = step?.completed === true
      if (done) return { content: String(step?.content ?? ''), status: 'completed' }
      if (!markedInProgress) {
        markedInProgress = true
        return { content: String(step?.content ?? ''), status: 'in_progress' }
      }
      return { content: String(step?.content ?? ''), status: 'pending' }
    })
  }

  // 没有 steps 明细（例如 active/read 查询）时，按计数合成一个占位列表，
  // 让 reducer 至少能更新进度条，但不编造步骤文案。
  const total = Number(rawBulk?.totalCount) || 0
  const done = Number(rawBulk?.doneCount) || 0
  if (!total) return []
  const steps = []
  for (let i = 0; i < total; i += 1) {
    const status = i < done ? 'completed' : (i === done ? 'in_progress' : 'pending')
    steps.push({ content: '', status })
  }
  return steps
}

/**
 * 每个 seek-agent 会话的翻译状态。
 * 保存 reducer 需要的 session 外观、seq 计数器、以及未闭合的 tool call id。
 */
class SessionBridge {
  constructor(sessionId, sessionName) {
    this.id = String(sessionId || 'unknown-session')
    this.name = sessionName || this.id
    this.seq = 0
    this.turnActive = false
    this.openCallId = null
    this.toolSeq = 0
    /** reducer 眼中的 session 外形 */
    this.session = {
      id: this.id,
      title: this.name,
      cwd: undefined,
      header: { id: this.id, title: this.name, origin: 'user', delegationDepth: 0 },
    }
  }

  nextSeq() {
    this.seq += 1
    return this.seq
  }

  /** 设置工作目录（reducer 用它显示项目名） */
  setCwd(cwd) {
    if (!cwd || cwd === this.session.cwd) return null
    this.session.cwd = cwd
    this.session.header.cwd = cwd
    return null
  }

  makeEvent(type, data) {
    return { type, seq: this.nextSeq(), data }
  }
}

export class CompanionBridge {
  /**
   * @param {object} opts
   * @param {boolean} [opts.includeSubagents] 子 agent 是否参与状态争抢
   * @param {(messages: object[]) => void} opts.deliver 把协议消息交给显示层
   */
  constructor({ includeSubagents = false, deliver } = {}) {
    this.reducer = new CompanionReducer({ includeSubagents })
    this.sessions = new Map()
    this.deliver = typeof deliver === 'function' ? deliver : () => {}
    this.includeSubagents = includeSubagents
  }

  #session(sessionId, sessionName) {
    let entry = this.sessions.get(String(sessionId))
    if (!entry) {
      entry = new SessionBridge(sessionId, sessionName)
      this.sessions.set(entry.id, entry)
    } else if (sessionName && entry.name !== sessionName) {
      entry.name = sessionName
      entry.session.title = sessionName
      entry.session.header.title = sessionName
    }
    return entry
  }

  /** 统一的出站：跑 reducer 并把产出交给显示层 */
  #feed(session, event) {
    let messages = []
    try {
      messages = this.reducer.handle(session.session, event) || []
    } catch (err) {
      // reducer 出问题绝不能让主进程崩掉，也不能吞掉后续事件
      console.error('[dafeiyu] reducer 处理失败：', err)
      return
    }
    if (messages.length) this.deliver(messages)
  }

  /**
   * 消费一条 seek-agent 消息。
   * @param {object} msg 主进程 handleAgentMessage 拿到的原始消息（含 sessionId）
   */
  handle(msg) {
    if (!msg || typeof msg.type !== 'string') return
    const sessionId = msg.sessionId
    const entry = this.#session(sessionId, msg.sessionName || msg.title)

    switch (msg.type) {
      case 'workdir:changed': {
        const cwd = typeof msg.path === 'string' ? msg.path : msg.state?.active
        entry.setCwd(cwd)
        return
      }

      // 一轮开始 / 结束
      case 'state': {
        if (msg.processing === true && !entry.turnActive) {
          entry.turnActive = true
          entry.openCallId = null
          this.#feed(entry, entry.makeEvent('turn/start', {}))
        } else if (msg.processing === false && entry.turnActive) {
          entry.turnActive = false
          entry.openCallId = null
          this.#feed(entry, entry.makeEvent('turn/end', {
            reason: { kind: msg.error ? 'error' : 'completed' },
          }))
        }
        return
      }

      // 思考态：reducer 用 assistant/message 表示「在没有未闭合工具时回到思考」
      case 'thinking':
      case 'thinking-bubble': {
        if (msg.active === false) return
        if (!entry.turnActive) return
        this.#feed(entry, entry.makeEvent('assistant/message', {}))
        return
      }
      case 'thinking-delta':
      case 'append':
        return

      case 'message': {
        // 用户发话：让 reducer 知道「等待中的人已回应」。
        // seek-agent 用 role 区分消息（不是独立的 message-user 事件类型）。
        if (msg.role === 'user') {
          this.#feed(entry, entry.makeEvent('user/message', {}))
          return
        }
        if (msg.role !== 'tool') return

        // todo 工具的结果藏在 rawBulk 里（seek-agent 没有独立的顶层 todo 事件），
        // 先把它翻成 reducer 的 todo/write，再走常规的工具结果处理。
        if (msg.rawBulk?.type === 'todo' && !msg.rawBulk?.error) {
          const steps = todosToReducerSteps(msg.rawBulk)
          if (steps.length) {
            this.#feed(entry, entry.makeEvent('todo/write', { todos: steps }))
          }
        }

        const name = toolNameOf(msg)
        const hasCall = !!(msg.toolMeta || msg.rawBulk?.name)
        const isResult = !!(msg.rawBulk || msg.fullOutput || msg.toolResultHtml)

        if (hasCall && name) {
          entry.toolSeq += 1
          const callId = `call-${entry.id}-${entry.toolSeq}`
          entry.openCallId = callId
          this.#feed(entry, entry.makeEvent('tool/call', {
            name,
            callId,
            message: { name, source: { callId } },
          }))
        }
        if (isResult) {
          const callId = entry.openCallId
          entry.openCallId = null
          const error = msg.rawBulk?.error || msg.rawBulk?.isError || msg.error
          this.#feed(entry, entry.makeEvent('tool/result', {
            callId,
            message: { callId },
            ...(error ? { error: { code: typeof error === 'string' ? error : 'tool-error' } } : {}),
          }))
        }
        return
      }

      // 工具计数（无名字）：只用于维持 WORKING 态
      case 'tool-call':
        return



      // 待办清单 → 真实进度
      case 'todo': {
        const todos = Array.isArray(msg.todos) ? msg.todos : msg.data?.todos
        if (!Array.isArray(todos)) return
        this.#feed(entry, entry.makeEvent('todo/write', { todos }))
        return
      }

      // 会话结束
      case 'exit':
      case 'session-error': {
        if (msg.type === 'session-error') {
          this.#feed(entry, entry.makeEvent('turn/end', {
            reason: { kind: 'error' },
          }))
        }
        const messages = this.reducer.disposeSession(entry.session) || []
        if (messages.length) this.deliver(messages)
        this.sessions.delete(entry.id)
        return
      }

      default:
        return
    }
  }

  /** 用户提交输入时调用：让 reducer 知道「等待中的人已回应」 */
  handleUserInput(sessionId) {
    const entry = this.sessions.get(String(sessionId))
    if (!entry) return
    this.#feed(entry, entry.makeEvent('user/message', {}))
  }

  /** 子 agent 开关切换 */
  setIncludeSubagents(value) {
    this.includeSubagents = value === true
    const messages = this.reducer.setIncludeSubagents(this.includeSubagents) || []
    if (messages.length) this.deliver(messages)
  }
}
