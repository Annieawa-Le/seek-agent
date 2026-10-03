// 桌宠窗口状态自检：把窗内的运行情况暴露成一个可查询的快照，便于在没有
// 视觉检查的情况下确认「窗口起来了 / 素材加载了 / 当前在播哪一帧」。
//
// 由 pet-window.js 维护，main.js 通过 RPC 读出。

export function createPetStatus() {
  const state = {
    openedAt: null,
    pageLoaded: false,
    assetsLoaded: false,
    clipCount: 0,
    currentClip: null,
    lastState: null,
    lastMessage: null,
    lastDetail: null,
    lastError: null,
    messagesSeen: 0,
    lastSeqAt: null,
  }

  return {
    snapshot() {
      return { ...state }
    },
    markOpened() {
      state.openedAt = Date.now()
    },
    markPageLoaded() {
      state.pageLoaded = true
    },
    markAssets(clipCount, currentClip) {
      state.assetsLoaded = true
      state.clipCount = clipCount
      state.currentClip = currentClip
    },
    markMessage(msg) {
      state.messagesSeen += 1
      state.lastSeqAt = Date.now()
      if (msg?.kind === 'state') {
        state.lastState = msg.state ?? null
        state.lastMessage = msg.message ?? null
        state.lastDetail = msg.detail ?? null
        state.currentClip = state.currentClip // clip 由页面自行决定
      } else if (msg?.kind === 'pulse') {
        state.lastState = msg.state ?? state.lastState
        state.lastMessage = msg.message ?? state.lastMessage
      }
    },
    markError(err) {
      state.lastError = err instanceof Error ? err.message : String(err)
    },
  }
}
