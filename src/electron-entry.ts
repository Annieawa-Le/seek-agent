/**
 * electron-entry.ts — Electron 模式的 Agent 入口
 *
 * 替代 index.ts 的 TUI 模式，使用 ElectronUIBridge
 * 通过 stdio JSON 协议与 Electron 主进程通信。
 *
 * 由 Electron 主进程以 child_process 方式启动：
 *   npx tsx src/electron-entry.ts
 */

import 'dotenv/config';
import { CLIAAgent } from './agent';
import { ElectronUIBridge } from './electron-bridge';
import { createMessageHook } from './message_managing';
import { composeHooks } from './memory_agent';
import { buildEditModePinningHook } from './tools/desk-edit';
import { createCommandRegistry } from './command';

// ── 创建 Bridge ──
const bridge = new ElectronUIBridge();

// ── 创建 Agent ──
const agent = new CLIAAgent(bridge as any);

agent.messageHook = composeHooks(
  createMessageHook(),
  buildEditModePinningHook(),
);

// ── 指令注册 ──
const commandRegistry = createCommandRegistry();

// ── 用户提交输入 ──
bridge.onSubmit = async (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) return;

  const handled = await commandRegistry.tryExecute(trimmed, { ui: bridge as any, agent });
  if (handled) return;

  await agent.run(trimmed);
};

// ── 退出 ──
bridge.onExit = async () => {
  try {
    const { subAgentManager } = await import('./tools/inner_skills/sub-agent/manager');
    const agentCount = subAgentManager.getAll().length;
    if (agentCount > 0) {
      subAgentManager.fireAll();
    }
  } catch {
    // ignore
  }
  process.exit(0);
};

// ── 命令转发 ──
bridge.onCommand = async (cmd: string) => {
  switch (cmd) {
    case 'memory_shorten': {
      const { memoryShorten } = await import('./tools/memory');
      const msgs = agent.getMessages();
      const result = await (memoryShorten as any).execute({ keepRounds: 3 }, { messages: msgs });
      bridge.addToolMessage(String(result));
      break;
    }
    case 'save_session': {
      await agent.run('/save');
      break;
    }
    case 'memory_focus': {
      const { memoryFocus } = await import('./tools/memory');
      const msgs = agent.getMessages();
      const result = await (memoryFocus as any).execute({ keepRounds: 3 }, { messages: msgs });
      bridge.addToolMessage(String(result));
      break;
    }
    case 'interrupt_agents': {
      const { subAgentManager } = await import('./tools/inner_skills/sub-agent/manager');
      subAgentManager.fireAll();
      break;
    }
    default: {
      // 尝试通过指令系统执行（如 workdir-global <path>）
      const handled = await commandRegistry.tryExecute(cmd, { ui: bridge as any, agent });
      if (!handled) {
        console.warn(`[entry] unknown command: ${cmd}`);
      }
      break;
    }
  }
};

// ── 启动 stdin 监听（接收主进程消息） ──
bridge.startListening();

// ── 通知主进程已就绪 ──
bridge.emitReady();

