/**
 * dsh-whale-widget —— 鲸鱼娘记账挂件（DSH → seek-agent 移植）
 *
 * 本 skill 的「本体」不是一个普通工具，而是一整个第三方挂件：
 *   - widget/     dsh-whale-widget 原包（lib/ 宿主 + assets/ 前端与素材），原样保留
 *   - shim.mjs    假 DSH 宿主壳：给插件的 lib/index.js 提供它需要的 ctx（webServer/credentials/effect/...）
 *   - enable.json 总开关
 *
 * 注意：seek-agent 的 inner_skill 运行在 **agent 子进程**里，而把挂件注入 Electron 渲染层只有
 * **主进程**能做（webContents）。所以真正的宿主托管放在 electron/main.js —— 它读取本目录、
 * 启动 HTTP server（用 shim.mjs 加载插件的 lib/index.js）、注入前端、并把每轮 usage 转发给插件。
 * 这里只导出一个状态查询工具，让模型能感知这个 skill 的存在。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return ''
  }
})()

export const whale_widget_status = tool({
  description:
    '查看「鲸鱼娘记账挂件」（dsh-whale-widget 移植版）的启用状态、资源目录与宿主方式。仅查询，不改变任何状态。',
  inputSchema: z.object({}),
  execute: async () => {
    let enable: { enable?: boolean } | null = null
    try {
      enable = JSON.parse(await readFile(path.join(SKILL_DIR, 'enable.json'), 'utf-8'))
    } catch {
      /* enable.json 读不到（例如被编译搬走）时按未知处理 */
    }
    return [
      `鲸鱼娘挂件：${enable?.enable === false ? '已禁用' : '已启用'}`,
      `资源目录：${SKILL_DIR || '(未知)'}`,
      '宿主：Electron 主进程托管（假 DSH ctx + 本地 HTTP server + 每轮 usage 桥接）',
      '前端：widget/assets/whale-widget.js（原样复用，URL 重写到宿主端口）',
    ].join('\n')
  },
})
