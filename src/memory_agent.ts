/**
 * memory_agent.ts — 消息 Hook 组合工具
 *
 * MemoryAgent 类已被弃用，改用 tools/memory.ts 中的
 * memory_focus / memory_shorten 工具让 AI 自主管理上下文。
 *
 * 仅保留 composeHooks 供 index.ts 组合 messageHook 链使用。
 */

import { ModelMessage } from 'ai';

export function composeHooks(
  ...hooks: ((messages: ModelMessage[]) => ModelMessage[])[]
): (messages: ModelMessage[]) => ModelMessage[] {
  return (messages: ModelMessage[]): ModelMessage[] => {
    let current = messages;
    for (const hook of hooks) {
      if (hook) current = hook(current);
    }
    return current;
  };
}
