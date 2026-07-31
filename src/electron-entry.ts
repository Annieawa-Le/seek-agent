/**
 * electron-entry.ts — Electron 模式的 Agent 入口
 *
 * 替代 index.ts 的 TUI 模式，使用 ElectronUIBridge
 * 通过 stdio JSON 协议与 Electron 主进程通信。
 *
 * 由 Electron 主进程以 child_process 方式启动：
 *   npx tsx src/electron-entry.ts
 *
 * 多会话：每个会话由主进程拉起一个独立的本入口进程，
 * 通过环境变量 AGENT_SESSION_ID 标识会话身份。
 */

import 'dotenv/config';
import { CLIAAgent } from './agent';
import { ElectronUIBridge } from './electron-bridge';
import { createMessageHook } from './message_managing';
import { composeHooks } from './memory_agent';
import { registerRoundHooks } from './register-round-hooks';
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

// ── 每轮结束后的后台任务（做梦沉淀 + 会话标题刷新），与 TUI 入口一致 ──
registerRoundHooks(agent, (msg) => bridge.addToolMessage(msg));

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

/** 收集侧边栏运行时数据（hooks / 子 agent / MCP 状态） */
async function collectSidebarData() {
  const hooks: Array<{ name: string; description?: string }> = [];
  if (agent.messageHook) hooks.push({ name: 'messageHook', description: '发送给模型前的消息预处理（去重/编辑模式固定）' });
  if (agent.postRoundHook) hooks.push({ name: 'postRoundHook', description: '每轮结束后的后台任务（记忆沉淀/标题刷新）' });

  let subAgents: Array<{ name: string; mode?: string; status?: string }> = [];
  try {
    const { subAgentManager } = await import('./tools/inner_skills/sub-agent/manager');
    subAgents = subAgentManager.getAll().map((a) => ({
      name: a.name,
      mode: a.mode,
      status: a.status,
    }));
  } catch { /* 子 agent 系统不可用时忽略 */ }

  let mcp: Array<{ name: string; initialized: boolean; error?: string }> = [];
  try {
    const { getMcpManager } = await import('./mcp');
    mcp = getMcpManager()?.getStatus() ?? [];
  } catch { /* MCP 未初始化时忽略 */ }

  return {
    sessionId: process.env.AGENT_SESSION_ID || 'default',
    hooks,
    subAgents,
    mcp,
    context: { messageCount: agent.getMessages().length },
  };
}

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
    case 'thinking_enable': {
      agent.setThinking(true);
      bridge.addToolMessage('思考模式已启用');
      break;
    }
    case 'thinking_disable': {
      agent.setThinking(false);
      bridge.addToolMessage('思考模式已禁用');
      break;
    }
    // ── 多会话控制（由主进程按会话路由下发） ──
    case 'session:activate': {
      // 切换回本会话时重放当前 UI 消息（复用会话加载的消息重建逻辑）
      const { reconstructUIMessages } = await import('./command/commands/loadsession.command');
      const uiMessages = reconstructUIMessages({ agentMessages: agent.getMessages() });
      bridge.replaceMessages(uiMessages);
      break;
    }
    case 'session:new': {
      // 新建会话：清空 agent 消息与 UI
      agent.clear();
      break;
    }
    case 'sidebar:data': {
      const data = await collectSidebarData();
      bridge.sendSidebarData(data);
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

