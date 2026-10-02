/**
 * command-log.ts — command_log 工具
 *
 * execute_command 返回给模型的文本被截断到 10000 字符，完整输出落盘到会话的
 * latest-cmd.log（sessions/{sessionId}/latest-cmd.log）。本工具把该日志取回，
 * 供模型查看超出截断上限的完整命令结果。
 */

import { tool } from 'ai';
import { z } from 'zod';
import { ToolOutput } from './tool-output';
import type { CmdLogBulk } from './raw-bulk-types';
import { cmdLogStore } from './cmd-log-store';

/** 返回内容的默认字符上限（超过则截断，可用 maxChars 覆盖） */
const DEFAULT_MAX_CHARS = 100_000;

export const commandLogTool = tool({
  description: [
    '取回最近一次 execute_command 的完整输出。',
    'execute_command 返回的文本被截断到 10000 字符，完整结果落盘到会话的 latest-cmd.log，用本工具取回。',
    '可用 maxChars 限制返回长度（默认 100000 字符，超出会截断）。',
  ].join(' '),
  inputSchema: z.object({
    maxChars: z.number().optional().describe('返回内容的最大字符数，默认 100000'),
  }),
  execute: async ({ maxChars }) => {
    const filePath = cmdLogStore.filePath;
    const raw = cmdLogStore.read();
    if (raw === null) {
      const msg = `📭 暂无命令日志（${filePath}）。执行 execute_command 后会自动写入最近一次结果。`;
      const bulk: CmdLogBulk = {
        type: 'cmd-log', action: 'read', found: false, filePath,
        size: 0, truncated: false, error: msg,
      };
      return new ToolOutput(bulk, msg);
    }
    const limit = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
      ? Math.round(maxChars)
      : DEFAULT_MAX_CHARS;
    const size = raw.length;
    const truncated = size > limit;
    const content = truncated ? raw.slice(0, limit) + `\n…（已截断，完整日志共 ${size} 字符）` : raw;
    const msg = `📜 最近一次命令日志（${filePath}，共 ${size} 字符）：\n${content}`;
    const bulk: CmdLogBulk = {
      type: 'cmd-log', action: 'read', found: true, filePath,
      size, truncated, content,
    };
    return new ToolOutput(bulk, msg);
  },
});
