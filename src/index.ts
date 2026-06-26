/**
 * 全局未捕获异常/未处理 Promise 拒绝处理器
 * 防止 tsx hook 传播到 worker_threads 导致的模块解析错误等异常使进程崩溃
 */
process.on('uncaughtException', (error: any) => {
  // 只拦截已知的「无害」错误或 tsx/worker 相关的模块解析错误
  const msg = error?.message || '';
  if (
    error?.name === 'AI_NoOutputGeneratedError' ||
    msg.includes('No output generated') ||
    // tesseract.js worker_threads 在 tsx 下的模块解析错误
    msg.includes('Cannot find module') && msg.includes('tesseract.js') && msg.includes('.jsx') ||
    msg.includes('worker-script')
  ) {
    return; // 静默吞掉
  }
  console.error('[FATAL] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || reason?.toString() || '';
  if (
    reason?.name === 'AI_NoOutputGeneratedError' ||
    msg.includes('No output generated') ||
    msg.includes('worker-script')
  ) {
    return;
  }
  console.error('[FATAL] Unhandled rejection:', reason);
});

import 'dotenv/config';
import { TerminalUI } from './ui';
import { CLIAAgent } from './agent';
import { createMessageHook } from './message_managing';
import { composeHooks } from './memory_agent';
import { buildEditModePinningHook } from './tools/desk-edit';
import { createCommandRegistry } from './command';

const ui = new TerminalUI();
const agent = new CLIAAgent(ui);

agent.messageHook = composeHooks(
  createMessageHook(),
  buildEditModePinningHook(),
);

// ── 指令注册中心 ──
const commandRegistry = createCommandRegistry();

// ── 用户提交输入时触发 agent 运行 ──
ui.onSubmit = async (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) return;

  // 优先匹配指令系统
  const handled = await commandRegistry.tryExecute(trimmed, { ui, agent });
  if (handled) return;

  // 非指令则提交到 agent
  await agent.run(trimmed);
};

// ── 退出回调 ──
ui.onExit = async () => {
  // 优先级：主 agent 清理 → 销毁所有子 agent → 关闭 OCR 进程 → 退出
  try {
    // 1) 销毁所有子 agent
    const { subAgentManager } = await import('./tools/inner_skills/sub-agent/manager');
    const agentCount = subAgentManager.getAll().length;
    if (agentCount > 0) {
      subAgentManager.fireAll();
    }
  } catch {
    // 子 agent 相关错误不阻止退出
  }
  try {
    // 2) 关闭 OCR 进程
    const { ocrManager } = await import('./tools/inner_skills/image-identifier/scripts/ocr-manager');
    ocrManager.shutdown();
  } catch {
    // OCR 清理错误不阻止退出
  }
  // 3) 退出进程
  process.exit(0);
};
// ── 快捷键命令 ──
ui.onCommand = async (cmd: string) => {
  switch (cmd) {
    case 'memory_shorten': {
      ui.addToolMessage('■ 快捷键: Ctrl+Q — 清理工具调用结果');
      const { memoryShorten } = await import('./tools/memory');
      const msgs = agent.getMessages();
      const result = await (memoryShorten as any).execute({ keepRounds: 3 }, { messages: msgs });
      ui.addToolMessage(String(result));
      break;
    }
    case 'save_session': {
      ui.addToolMessage('■ 快捷键: Ctrl+S — 保存会话');
      await agent.run('/save');
      break;
    }
    case 'memory_focus': {
      ui.addToolMessage('■ 快捷键: Ctrl+W — 折叠 3 轮前的内容');
      const { memoryFocus } = await import('./tools/memory');
      const msgs = agent.getMessages();
      const result = await (memoryFocus as any).execute({ keepRounds: 3 }, { messages: msgs });
      ui.addToolMessage(String(result));
      break;
    }
    case 'interrupt_agents': {
      const { subAgentManager } = await import('./tools/inner_skills/sub-agent/manager');
      ui.addToolMessage('■ 快捷键: Tab — 中断所有子 agent');
      subAgentManager.fireAll();
      break;
    }
  }
};

// ── 启动 UI ──
ui.start();





