/**
 * register-round-hooks.ts — 每轮结束后的公共钩子注册
 *
 * TUI（index.ts）与 Electron（electron-entry.ts）共用同一套 postRoundHook：
 *   1. 做梦沉淀：把未沉淀的工作记忆提炼为长期知识（轻量模型）
 *   2. 会话标题刷新：轻量模型总结标题，用于 session 文件命名
 *
 * 两者均为后台 fire-and-forget，不阻塞下一轮。
 */

import type { CLIAAgent } from './agent';
import { dreaming } from './tools/memory-dreaming';

/**
 * 注册每轮结束后的后台任务钩子。
 * @param agent  目标 agent 实例
 * @param notify 完成通知回调（如 ui.addToolMessage / bridge.addToolMessage）
 */
export function registerRoundHooks(
  agent: CLIAAgent,
  notify: (msg: string) => void,
): void {
  agent.postRoundHook = (_userInputs, _assistantText, _toolCallIds, messages) => {
    // 做梦沉淀：未沉淀记忆攒够阈值才调模型
    void dreaming(messages)
      .then((result) => {
        if (!result.skipped) {
          notify(`🧠 做梦沉淀完成：提炼 ${result.precipitated} 条长期记忆`);
        }
      })
      .catch(() => { /* 沉淀失败静默，不影响主流程 */ });

    // 会话标题刷新：轻量模型总结标题，用于 session 文件命名
    void agent.refreshSessionTitle().catch(() => { /* 标题失败不影响主流程 */ });
  };
}
