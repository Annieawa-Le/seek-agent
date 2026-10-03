/**
 * 工具调用的人类可读标签（TUI / WebUI 渲染用）
 *
 * 必须使用完整形态 { icon, category, callLabel, collapse? }——
 * tool-translations.ts 的 friendlyToolCallLabel 会直接调用 callLabel(args)，
 * 只写 { label, template, description } 简写会在工具调用渲染时抛 TypeError，
 * 进而留下「孤立 tool-call」导致会话 400。
 */
import type { ToolTranslation } from '../../../assets/tool-translations'

export default {
  doc_pool: {
    icon: '■',
    category: 'other',
    callLabel: (args: Record<string, unknown>) =>
      `文件池: ${args?.pool_name ?? '(?)'} ← ${args?.name ?? '(?)'}`,
  },
  'doc-pool-prompt-get': {
    icon: '■',
    category: 'other',
    callLabel: () => '文件池: 获取技能文档',
  },
} satisfies Record<string, ToolTranslation>

