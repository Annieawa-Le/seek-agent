/**
 * dsh-dafeiyu —— 大肥鱼桌宠（DSH → seek-agent 移植）
 *
 * 本 skill 的「本体」是一个桌面窗口挂件，不是一个普通工具：
 *   - lib/        DSH 版内核原样移植（protocol / status-copy / companion-reducer，零外部依赖）
 *   - bridge.mjs  事件桥：把 seek-agent 的事件词汇翻译成 DSH 的 session/event
 *   - pet-window.js  透明置顶窗（Electron 主进程侧）
 *   - pet.html    窗内页面：按 manifest 播 webp 序列帧
 *   - assets/     16 组动画素材（2600 帧）与 pet-manifest.json
 *   - enable.json 总开关与显示配置
 *
 * 与另两个挂件的差别：桌宠不开 HTTP 宿主，也不注入渲染层。它由 electron/main.js
 * 直接开一个独立窗口，状态来自 agent 事件流经事件桥送进 CompanionReducer。
 *
 * 这里只导出一个状态查询工具，让模型能感知这个 skill 的存在与开关状态。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return ''
  }
})()

const STATE_LABELS: Record<string, string> = {
  IDLE: '空闲',
  THINKING: '思考',
  WORKING: '工作',
  WAITING: '等待确认',
  SUCCESS: '完成',
  ERROR: '出错',
  DISCONNECTED: '未连接',
}

export const dafeiyu_status = tool({
  description:
    '查看「大肥鱼桌宠」（dsh-dafeiyu 移植版）的启用状态、动画素材与宿主方式。仅查询，不改变任何状态。',
  inputSchema: z.object({}),
  execute: async () => {
    let cfg: Record<string, unknown> | null = null
    try {
      cfg = JSON.parse(await readFile(path.join(SKILL_DIR, 'enable.json'), 'utf-8'))
    } catch {
      /* enable.json 读不到（例如被编译搬走）时按未知处理 */
    }

    let clipCount = 0
    let frameCount = 0
    try {
      const petDir = path.join(SKILL_DIR, 'assets', 'pet')
      const clips = await readdir(petDir)
      clipCount = clips.length
      for (const clip of clips) {
        frameCount += (await readdir(path.join(petDir, clip))).length
      }
    } catch {
      /* 素材缺失时保持 0 */
    }

    const states = Object.entries(STATE_LABELS)
      .map(([key, label]) => `${label}(${key})`)
      .join(' / ')

    const lines = [
      `大肥鱼桌宠：${cfg?.enable === false ? '已禁用' : '已启用'}`,
      `资源目录：${SKILL_DIR || '(未知)'}`,
      `素材：${clipCount} 组动画 / ${frameCount} 帧`,
      `状态映射：${states}`,
      `缩放：${cfg?.scale ?? 1} · 气泡：${cfg?.bubbleMode ?? 'always'} · 减少动态：${cfg?.reducedMotion === true ? '是' : '否'}`,
      '宿主：Electron 主进程开透明置顶窗；状态来自 agent 事件流 → bridge.mjs → CompanionReducer',
      '交互：左键拖拽移动、单击戳一下、双击摸头、右下角点尾巴',
    ]
    return lines.join('\n')
  },
})
