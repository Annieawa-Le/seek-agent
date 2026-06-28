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

// ── 知识库开关状态 ──
let kbEnabled = true;

/** 自动构建知识库索引（忽略构建失败，不阻塞用户输入） */
async function ensureKbIndex() {
  bridge.addKbStatus('building', '正在构建知识库索引...');
  try {
    const { kbBuildIndex } = await import('./tools/inner_skills/kb-query/scripts/build-index');
    const result = await kbBuildIndex.execute({ force: false });
    kbIndexBuilt = !result.startsWith('❌');
    if (kbIndexBuilt) {
      bridge.addKbStatus('done', '知识库索引已就绪');
    } else {
      bridge.addKbStatus('failed', '知识库索引构建失败');
    }
  } catch (e: any) {
    console.warn('[kb] 自动构建失败:', e.message);
    bridge.addKbStatus('failed', `知识库构建失败: ${e.message}`);
  }
}
let kbIndexBuilt = false;

// ── 用户提交输入 ──
bridge.onSubmit = async (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) return;

  const handled = await commandRegistry.tryExecute(trimmed, { ui: bridge as any, agent });
  if (handled) return;

  // 若知识库启用且尚未构建，后台异步构建（不阻塞消息）
  if (kbEnabled && !kbIndexBuilt) {
    kbIndexBuilt = true; // 防止重复触发
    ensureKbIndex(); // 不 await，放后台跑
  }

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
    case 'kb_enable': {
      kbEnabled = true;
      // 只加载 kb-query 一个技能
      try {
        const { loadSingleSkill } = await import('./tools/index');
        await loadSingleSkill('kb-query');
      } catch {}
      // 如果索引没构建过，立即触发
      if (!kbIndexBuilt) {
        ensureKbIndex().then(() => {
          bridge.addToolMessage('知识库已启用，索引已就绪');
        });
      }
      bridge.addToolMessage('知识库已启用');
      break;
    }
    case 'kb_disable': {
      kbEnabled = false;
      // 卸载整个 kb-query 技能，工具立即可见消失
      try {
        const { removeSkill } = await import('./tools/index');
        removeSkill('kb-query');
      } catch {}
      bridge.addToolMessage('知识库已禁用');
      break;
    }
    case 'smart_search_enable': {
      agent.setSmartSearch(true);
      bridge.addToolMessage('智能搜索已启用');
      break;
    }
    case 'smart_search_disable': {
      agent.setSmartSearch(false);
      bridge.addToolMessage('智能搜索已禁用');
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













