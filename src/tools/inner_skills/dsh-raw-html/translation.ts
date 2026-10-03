/**
 * 工具调用的人类可读标签（TUI / WebUI 渲染用）
 *
 * 必须使用完整形态 { icon, category, callLabel, collapse? }——
 * tool-translations.ts 的 friendlyToolCallLabel 会直接调用 callLabel(args)，
 * 只写 { label, action } 简写会在工具调用渲染时抛 TypeError，
 * 进而留下「孤立 tool-call」导致会话 400。
 */
import type { ToolTranslation } from '../../../assets/tool-translations'

export default {
  style_list: {
    icon: '■',
    category: 'other',
    callLabel: () => '风格库: 列出视觉风格',
  },
  style_get: {
    icon: '■',
    category: 'other',
    callLabel: (args: Record<string, unknown>) => `风格库: 读取 ${args?.slug ?? '(?)'}`,
  },
  raw_html_status: {
    icon: '■',
    category: 'other',
    callLabel: () => '视觉卡片: 查看插件状态',
  },
} satisfies Record<string, ToolTranslation>

