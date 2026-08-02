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
import * as fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceRoot } from './workdir';
import { CLIAAgent } from './agent';
import { ElectronUIBridge } from './electron-bridge';
import { createMessageHook } from './message_managing';
import { composeHooks } from './memory_agent';
import { registerRoundHooks } from './register-round-hooks';
import { buildEditModePinningHook } from './tools/desk-edit';
import { createCommandRegistry } from './command';
import { modePreProcessHook } from './modes/preprocess';
import { registerBuiltinModes } from './modes';
import { registerManagerDashboard } from './modes/panel';
import { isActiveMode, getActiveModeNames } from './modes/registry';
import { appendChatMessage, getChatThreads } from './modes/chat-thread';

// ── 创建 Bridge ──
const bridge = new ElectronUIBridge();

// ── 创建 Agent ──
const agent = new CLIAAgent(bridge as any);

// ── 注册内置模式（kb / manager / worker） ──
registerBuiltinModes();
registerManagerDashboard();

// ── 启动时恢复会话模式（模式随会话持久化：进程重启后切回仍生效） ──
try {
  const sessionId = process.env.AGENT_SESSION_ID;
  if (sessionId) {
    const { setActiveModes } = await import('./modes/registry');
    const sessionsDir = path.join(getWorkspaceRoot(), 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
          if (data.sessionId === sessionId && Array.isArray(data.mode) && data.mode.length > 0) {
            const res = setActiveModes(data.mode);
            if (res.ok) agent.reloadPrompt();
            break;
          }
        } catch { /* 单个文件解析失败跳过 */ }
      }
    }
  }
} catch { /* 恢复失败不影响启动 */ }

agent.messageHook = composeHooks(
  createMessageHook(),
  modePreProcessHook,
  buildEditModePinningHook(),
);

// ── 每轮结束后的后台任务（做梦沉淀 + 会话标题刷新），与 TUI 入口一致 ──
registerRoundHooks(agent, (msg) => bridge.addToolMessage(msg));

// ── 指令注册 ──
const commandRegistry = createCommandRegistry();

// ── 知识库开关状态 ──
let kbEnabled = true;

/** 推送输入栏状态快照给渲染层（胶囊开关 + 处理中标志），供按会话同步 */
function pushInputState() {
  bridge.sendInputState(kbEnabled, agent.getSmartSearch(), agent.getThinking());
}

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
    // 当前激活模式（渲染层通讯录标签：manager=下属 / worker=帮手）
    mode: getActiveModeNames(),
    // 协作聊天 thread（右侧面板通讯录 + 聊天视图数据源）
    threads: getChatThreads(),
  };
}

// ── 用户提交输入 ──
// ── 跨会话协作：收到其他会话发来的协作消息 ──
bridge.onCollabMessage = async (from: string, content: string) => {
  bridge.addCollabMessage(from, content);
  // 协作消息写入聊天 thread（peer 角色，供右侧协作面板聊天视图）
  appendChatMessage(from, 'worker', 'peer', content);
  // 打工人模式下，协作消息视为工作任务；否则视为普通协作消息
  const isWorker = isActiveMode('worker');
  const instruction = isWorker
    ? `这是一条来自会话「${from}」的【工作任务】。请按打工人模式流程执行：拆解步骤 → 执行 → 自检 → 用 collab_send 将结构化结果回传给会话「${from}」（回传地址已在消息头中）。`
    : `这是一条来自会话「${from}」的协作消息。请阅读并回复；如需向对方提问或同步信息，可用 collab_send 工具。`;
  await agent.run(`【协作消息·来自会话「${from}」】\n${content}\n\n${instruction}`);
};
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
  // ── 静默模式切换（ModePicker 用，带参命令如 mode:set kb；只改模式不产生消息） ──
  if (cmd.startsWith('mode:set')) {
    const modeName = cmd.slice('mode:set'.length).trim() || 'default';
    try {
      const { setActiveModes } = await import('./modes/registry');
      const res = setActiveModes([modeName]);
      if (res.ok) agent.reloadPrompt();
    } catch { /* 切换失败静默 */ }
    return;
  }
  // ── 协作聊天发送（渲染层聊天视图 → agent；格式 chat:send <peer>|<content>） ──
  if (cmd.startsWith('chat:send ')) {
    const rest = cmd.slice('chat:send '.length);
    const sep = rest.indexOf('|');
    const peer = sep > 0 ? rest.slice(0, sep).trim() : rest.trim();
    const content = sep > 0 ? rest.slice(sep + 1) : '';
    if (!peer || !content) {
      bridge.addToolMessage('⚠ chat:send 需要 peer 和内容（格式: chat:send <peer>|<content>）');
      return;
    }
    const { subAgentManager } = await import('./tools/inner_skills/sub-agent/manager');
    const subAgent = subAgentManager.get(peer);
    if (subAgent) {
      // 子模型：记录派活 + 后台执行
      appendChatMessage(peer, 'subagent', 'manager', `【派活】${content}`);
      bridge.addToolMessage(`📤 已派活给子模型「${peer}」，后台执行中…`);
      (async () => {
        try {
          const { executeChildAgent } = await import('./tools/inner_skills/sub-agent/runner');
          const { getSystemPrompt } = await import('./model-provider');
          const result = await executeChildAgent(subAgent, agent.getMessages(), getSystemPrompt(), content);
          // 提交结果排队注入主对话
          try {
            const { queueSubmissionInjection } = await import('./tools/inner_skills/sub-agent/manager');
            queueSubmissionInjection(peer, JSON.parse(result));
          } catch { /* 非 JSON 不注入 */ }
          bridge.addToolMessage(`📥 子模型「${peer}」已完成`);
        } catch (e: any) {
          appendChatMessage(peer, 'subagent', 'peer', `执行出错: ${e?.message || e}`);
        }
      })();
      return;
    }
    // worker：collab_send
    appendChatMessage(peer, 'worker', 'manager', content);
    const res = await bridge.requestCollab('send', { to: peer, content });
    if (res?.ok) {
      bridge.addToolMessage(`📤 已发送给会话「${peer}」`);
    } else {
      appendChatMessage(peer, 'worker', 'peer', `发送失败: ${res?.error || '未知错误'}`);
      bridge.addToolMessage(`❌ 发送失败: ${res?.error || '未知错误'}`);
    }
    return;
  }
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
    case 'identity-card:generate': {
      try {
        const { generateIdentityCard } = await import('./tools/identity-card');
        const card = await generateIdentityCard(agent.getMessages());
        const meta = {
          name: agent.getSessionTitle() || '未命名会话',
          messageCount: agent.getMessages().length,
          mode: getActiveModeNames(), // 模式随身份卡暴露（供跨会话识别，如打工人模式）
        };
        if (card) {
          bridge.sendIdentityCard({ ...card, ...meta });
        } else {
          bridge.sendIdentityCard({ ...meta }, '对话内容不足或总结失败');
        }
      } catch (e: any) {
        bridge.sendIdentityCard({}, e.message || '身份卡生成失败');
      }
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
      pushInputState();
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
      pushInputState();
      break;
    }
    case 'smart_search_enable': {
      agent.setSmartSearch(true);
      bridge.addToolMessage('智能搜索已启用');
      pushInputState();
      break;
    }
    case 'smart_search_disable': {
      agent.setSmartSearch(false);
      bridge.addToolMessage('智能搜索已禁用');
      pushInputState();
      break;
    }
    case 'thinking_enable': {
      agent.setThinking(true);
      bridge.addToolMessage('思考模式已启用');
      pushInputState();
      break;
    }
    case 'thinking_disable': {
      agent.setThinking(false);
      bridge.addToolMessage('思考模式已禁用');
      pushInputState();
      break;
    }
    // ── 多会话控制（由主进程按会话路由下发） ──
    case 'session:activate': {
      // 切换回本会话时重放当前 UI 消息（复用会话加载的消息重建逻辑）
      const { reconstructUIMessages } = await import('./command/commands/loadsession.command');
      const uiMessages = reconstructUIMessages({ agentMessages: agent.getMessages() });
      bridge.replaceMessages(uiMessages);
      pushInputState(); // 切回本会话：推送真实处理中状态，空闲会话的发送按钮立即恢复
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

// 进程就绪后推送一次输入栏状态，渲染层据此恢复发送/停止按钮与胶囊比对基准
pushInputState();





































