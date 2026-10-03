/**
 * dsh-worktable —— 工作台（DSH → seek-agent 移植）
 *
 * 本 skill 的价值全在「宿主 UI 那一半」：侧边栏工作台抽屉、主区工作台舞台、控制室会话卡片。
 * 上游是 DSH Web 的 Cordis 插件（宿主路由 + slot 协议注入客户端 bundle），这里按 seek-agent
 * 的实际结构重新落地：
 *   - host.mjs        宿主半区（本地 HTTP 资源托管），由 electron/main.js 动态 import
 *   - client/         前端脚本，由 main.js 注入渲染层（DOM 挂载，不进 React）
 *   - enable.json     总开关
 *
 * 注意：inner_skill 跑在 **agent 子进程**里，而把 UI 注入 Electron 渲染层只有 **主进程** 能做
 * （webContents）。所以这里不提供任何操作类工具，只导出一个状态查询工具，让模型能感知
 * 这个 skill 的存在（同 dsh-whale-widget 的处理）。
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

export const worktable_status = tool({
  description:
    '查看「工作台」（dsh-worktable 移植版）的启用状态、资源目录与当前落地范围。仅查询，不改变任何状态。',
  inputSchema: z.object({}),
  execute: async () => {
    let enable: { enable?: boolean } | null = null
    try {
      enable = JSON.parse(await readFile(path.join(SKILL_DIR, 'enable.json'), 'utf-8'))
    } catch {
      /* enable.json 读不到（例如被编译搬走）时按未知处理 */
    }
    return [
      `工作台：${enable?.enable === false ? '已禁用' : '已启用'}`,
      `资源目录：${SKILL_DIR || '(未知)'}`,
      '宿主：Electron 主进程托管（读 enable.json → 动态 import host.mjs → 本地 HTTP → 注入前端）',
      '界面：侧边栏「工作台」抽屉（项目增删改 + 项目↔会话绑定）＋ 主区工作台舞台 ＋ 控制室会话卡片',
      '挂载方式：纯 DOM 挂载（不进 React）；切会话点宿主自己的会话条目（DOM 桥），复用宿主完整切换路径',
      '当前范围：M1-a；分栏引擎与窗格（资源管理器/终端/浏览器/自定义窗口）见 M1-b 起',
      '项目数据存渲染层 localStorage（dsh.worktable.*），agent 侧不持有；卸载删本目录即可',
    ].join('\n')
  },
})
