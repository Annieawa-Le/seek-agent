/**
 * ref-desk.ts — 参考桌面管理工具
 *
 * 让主模型可以主动管理 RefDesk（参考桌面）中的文件引用，
 * 将关键文件"钉"在上下文中，避免被记忆清理机制冲掉。
 */

import { tool } from 'ai';
import { z } from 'zod';
import { refDesk } from './ref-desk-core';

// ═════════════════════════════════════════════════════
// desk_add
// ═════════════════════════════════════════════════════

export const deskAddTool = tool({
  description: [
    '将一份文件的内容注册到「参考桌面」中。',
    '参考桌面中的文件会在每次消息清理后作为引用信息重新注入上下文，',
    '适合放那些需要长期记住、反复参考的关键文件（如项目结构、核心配置、领域模型等）。',
    '如果该文件路径已存在于桌面中，其内容会被覆盖更新。',
    'content 参数应当包含该文件的完整内容或足够代表其要义的摘要。',
  ].join(' '),
  inputSchema: z.object({
    filePath: z.string().describe('文件路径（用于在桌面上标识该条目）'),
    content: z.string().describe('文件内容或其摘要，需包含足够让后续工作参考的信息'),
  }),
  execute: async ({ filePath, content }) => {
    refDesk.set(filePath, content, Date.now());
    return `✅ 已将 ${filePath} 加入参考桌面（${content.length} 字符）`;
  },
});

// ═════════════════════════════════════════════════════
// desk_list
// ═════════════════════════════════════════════════════

export const deskListTool = tool({
  description: '列出当前「参考桌面」上所有已注册的文件条目，含文件路径和字符数摘要。',
  inputSchema: z.object({}),
  execute: async () => {
    const all = refDesk.getAll();
    if (all.length === 0) {
      return '📭 参考桌面上没有任何文件。';
    }
    const lines = all.map((entry, i) => {
      return `${i + 1}. ${entry.filePath}（${entry.content.length} 字符）`;
    });
    return `📋 参考桌面（共 ${all.length} 项）：\n${lines.join('\n')}`;
  },
});

// ═════════════════════════════════════════════════════
// desk_remove
// ═════════════════════════════════════════════════════

export const deskRemoveTool = tool({
  description: '从「参考桌面」中移除指定文件路径的条目，不再自动注入上下文。',
  inputSchema: z.object({
    filePath: z.string().describe('要从桌面上移除的文件路径'),
  }),
  execute: async ({ filePath }) => {
    if (refDesk.has(filePath)) {
      refDesk.remove(filePath);
      return `✅ 已将 ${filePath} 从参考桌面移除。`;
    }
    return `⚠ 参考桌面上未找到 ${filePath}，无需移除。`;
  },
});

// ═════════════════════════════════════════════════════
// desk_clear
// ═════════════════════════════════════════════════════

export const deskClearTool = tool({
  description: '清空整个「参考桌面」，移除所有已注册的文件条目。',
  inputSchema: z.object({}),
  execute: async () => {
    const count = refDesk.getAll().length;
    refDesk.clear();
    return `✅ 已清空参考桌面（移除了 ${count} 项）。`;
  },
});

