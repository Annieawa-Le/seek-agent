/**
 * seek-agent 用量 → DSH 插件用量的口径换算。
 *
 * 两边差一层语义，直接对接会把账算爆：
 *   - seek-agent 推的 usage 是**会话累计四桶**（agent.ts 的 accumulateUsage → electron-bridge
 *     setUsageSummary；输入框下面那行「用量 ↑x ↓y」用的就是它）。同一轮里每个 LLM 步骤都会把
 *     "截止到现在的总量"再推一次。
 *   - DSH 插件认为**每条 assistant/message 就是一次调用的用量**，收到就往上加
 *     （widget/lib/index.js 的 handleSessionEvent → agg），由它自己累出本轮小计。
 *
 * 于是「每轮都转发累计值」= 把历史总量按步骤数重复计一遍，账目随会话长度呈平方级膨胀
 * （实测单轮能算出几亿 token、上百元）。这里按会话维护基线，只吐两次之间的增量。
 */

const ZERO = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

export function createUsageCursor() {
  const cursors = new Map()

  return {
    /**
     * 消费一条 seek-agent usage 消息，返回这一步应记的用量。
     * @param {string} sessionId 会话 id（各会话的累计互相独立）
     * @param {object} msg       { type:'usage', inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
     * @returns {{inputTokens:number, cacheReadTokens:number, outputTokens:number}|null}
     *          本步没有增量时返回 null（不发事件，免得给本轮掺空步）
     */
    take(sessionId, msg) {
      if (!msg || typeof msg !== 'object') return null
      const now = {
        input: Number(msg.inputTokens) || 0,
        cacheRead: Number(msg.cacheReadTokens) || 0,
        cacheWrite: Number(msg.cacheWriteTokens) || 0,
        output: Number(msg.outputTokens) || 0,
      }
      const prev = cursors.get(sessionId)
      cursors.set(sessionId, now)
      // 累计值回落 = 换了 agent 进程（会话重载 / 重启），基线随之重置，这一段整体按新用量计；
      // 差值 clamp 到非负，避免基线抖动记出负数用量。
      const rolled = !!prev && (now.input < prev.input || now.cacheRead < prev.cacheRead
        || now.cacheWrite < prev.cacheWrite || now.output < prev.output)
      const base = prev && !rolled ? prev : ZERO
      const step = {
        // cacheWrite 没有独立档位：插件只认「未缓存输入 / 缓存命中 / 输出」三档，
        // 而缓存写本就是输入侧用量，并入输入按未命中价计（丢掉会少算）
        inputTokens: Math.max(0, now.input - base.input) + Math.max(0, now.cacheWrite - base.cacheWrite),
        cacheReadTokens: Math.max(0, now.cacheRead - base.cacheRead),
        outputTokens: Math.max(0, now.output - base.output),
      }
      if (!step.inputTokens && !step.cacheReadTokens && !step.outputTokens) return null
      return step
    },

    /** 丢弃某会话的基线（会话关闭 / 进程退出时调用，避免 Map 无限增长） */
    drop(sessionId) {
      cursors.delete(sessionId)
    },
  }
}
