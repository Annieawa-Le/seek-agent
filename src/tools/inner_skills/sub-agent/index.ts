/**
 * index.ts — sub-agent 技能入口
 *
 * 暴露 4 个主模型可用工具：
 *   spawn_agent — 创建子模型
 *   agent_task  — 给子模型委派任务并执行
 *   agent_query — 查询子模型状态
 *   agent_fire  — 销毁子模型
 * （a_submission 为子模型专用终端工具，由 runner.ts 的 buildChildTools 注入，
 *   不在此全局注册，主模型不可见。）
 */
import { tool } from 'ai';
import { z } from 'zod';
import { subAgentManager, queueSubmissionInjection, notifyTaskDispatched } from './manager';
import { executeChildAgent, queryChildAgent } from './runner';
import { getSystemPrompt } from '../../../model-provider';
import { appendChatMessage } from '../../../modes/chat-thread';
import type { ModelMessage } from 'ai';
import { docPoolStore, buildInjectionMessage } from '../../doc-pool-store';
import { subagentWorklogStore } from '../../../tools/subagent-worklog-store';
import { subagentContextStore } from '../../../tools/subagent-context-store';

const tools: Record<string, any> = {};

// ═════════════════════════════════════════════════════
// spawn_agent — 创建子模型
// ═════════════════════════════════════════════════════

tools['spawn_agent'] = tool({
  description: `创建/注册一个子 AI 模型，有三种模式可选：
- clone：子模型拥有主模型的所有上下文，最新一条 user 消息是主模型传进去的任务
- mission：子模型拥有独立的系统提示词，主模型传入上下文和任务
- instructor：子模型作为开发指导，在主模型每轮工作完成后发散思维提出建议`,
  inputSchema: z.object({
    mode: z.enum(['clone', 'mission', 'instructor']).describe('子模型模式: clone/mission/instructor'),
    name: z.string().describe('子模型的唯一名称，后续操作通过此名称引用'),
    tools: z.array(z.string()).optional().describe('子模型可调用的工具列表（工具名数组），不传则仅有 a_submission 等内置工具'),
    // clone 模式
    task: z.string().optional().describe('(clone 模式) 要执行的任务内容'),
    // mission 模式
    systemPrompt: z.string().optional().describe('(mission 模式) 子模型的自定义系统提示词'),
    contextAndTask: z.string().optional().describe('(mission 模式) 传给子模型的上下文和任务'),
    // instructor 模式
    requirement: z.string().optional().describe('(instructor 模式) instructor 的工作要求，指定发散思维的方向'),
    maxRounds: z.number().optional().describe('(instructor 模式) instructor 的最大输出轮次（默认 3）'),
  }),
  execute: async (args) => {
    const { mode, name, tools = [] } = args;

    if (subAgentManager.get(name)) {
      return `ℹ 子模型 "${name}" 已存在，将重新创建。`;
    }

    subAgentManager.spawn({
      mode,
      name,
      tools,
      systemPrompt: args.systemPrompt,
      context: args.contextAndTask,
      requirement: (args as any).requirement,
      maxRounds: (args as any).maxRounds,
    });
    // 通知外部（electron-entry 推送 sidebar:data）：通讯录立即出现新好友
    notifyTaskDispatched();

    const toolList = tools.length > 0 ? tools.join(', ') : '(无工具)';
    const extra = mode === 'instructor' ? `\n要求: ${(args as any).requirement || '(未设置)'} | 最大轮次: ${(args as any).maxRounds || 3}` : '';
    return `✅ 已创建 ${mode} 模式子模型 "${name}"\n可用工具: ${toolList}${extra}`;
  },
});

// ═════════════════════════════════════════════════════
// agent_task — 给子模型委派任务
// ═════════════════════════════════════════════════════

tools['agent_task'] = tool({
  description: '给已创建的子模型委派任务并立即执行。子模型会独立运行 LLM 循环并使用其被分配的工具。任务完成后子模型会通过 a_submission 提交结果。可选传 pool_name 把文件池（doc_pool 沉淀）内容作为参考上下文注入子模型初始对话。',
  inputSchema: z.object({
    name: z.string().describe('子模型名称（必须已通过 spawn_agent 创建）'),
    task: z.string().describe('要委派给子模型的详细任务描述'),
    context: z.string().optional().describe('额外上下文信息（mission 模式使用）'),
    pool_name: z.string().optional().describe('（可选）文件池名称：把该池中沉淀的文件片段作为参考上下文注入子模型初始对话'),
  }),
  execute: async ({ name, task, context, pool_name }, { messages }) => {
    const agent = subAgentManager.get(name);
    if (!agent) {
      return `❌ 未找到子模型 "${name}" 请先调用 spawn_agent 创建。`;
    }

    if (agent.status === 'running') {
      return `⚠ 子模型 "${name}" 正在运行中，请等待完成或先销毁。`;
    }

    // 文件池注入：把 pool_name 池的内容作为额外上下文（优先于显式 context 之前）
    let extraContext = context;
    if (pool_name) {
      const pool = docPoolStore.getPool(pool_name);
      if (pool && pool.entries.length > 0) {
        const injected = buildInjectionMessage(pool);
        extraContext = extraContext ? `${extraContext}\n\n${injected}` : injected;
      } else {
        return `⚠ 文件池 "${pool_name}" 为空或不存在。可先让子模型读取文件后用 doc_pool 沉淀，或检查池名。`;
      }
    }

    // manager 派活写入协作聊天 thread（manager 角色）
    appendChatMessage(name, 'subagent', 'manager', `【派活】${task}`);
    // 通知外部（electron-entry 推送 sidebar:data）：通讯录立即刷新（新 thread + running 状态）
    notifyTaskDispatched();

    // 异步派活：后台执行子模型，立即返回（主模型可继续派别的活或做其他事）
    const mainMsgs = messages as ModelMessage[];
    const mainSysPrompt = getSystemPrompt();
    (async () => {
      try {
        const result = await executeChildAgent(agent, mainMsgs, mainSysPrompt, task, extraContext);
        // 解析提交结果并排队注入其所属会话（跨会话后台任务：切回该会话时再注入）
        try {
          const parsed = JSON.parse(result);
          queueSubmissionInjection(name, parsed, agent.ownerSessionId || subagentContextStore.getSessionId());
        } catch { /* 非 JSON 结果不注入 */ }
      } catch (e: any) {
        appendChatMessage(name, 'subagent', 'peer', `执行出错: ${e?.message || e}`);
      }
    })();
    return `✅ 已派活给子模型 "${name}"（后台执行中，完成后结果会自动回到对话）`;
  },
});

// ═════════════════════════════════════════════════════
// agent_query — 查询子模型状态
// ═════════════════════════════════════════════════════

tools['agent_query'] = tool({
  description: '向子模型提问或查询状态。传 question 时，子模型的 LLM 会基于其自身的工作上下文（mission 模式加载上次派活的历史、clone 模式带主模型消息）直接回答问题，不调工具；不传 question 时返回状态摘要。注意：派活后无需等待——子模型完成后会通过「【name 提交工作结果】」自动回到对话。',
  inputSchema: z.object({
    name: z.string().describe('子模型名称'),
    question: z.string().optional().describe('向子模型提出的问题（将会让子模型的 LLM 回答）'),
    waitForCompletion: z.boolean().optional().default(false).describe('（已废弃）不再同步等待；仅用于查看已完成子模型的提交结果或当前状态'),
  }),
  execute: async ({ name, question, waitForCompletion }, { messages }) => {
    const agent = subAgentManager.get(name);
    if (!agent) {
      return `❌ 未找到子模型 "${name}"。`;
    }

    // 等待正在运行的子模型完成 → 已去除同步等待（异步协作：派活后直接结束本轮，提交会自动回到对话）
    if (waitForCompletion) {
      if (agent.status === 'running') {
        return `⏳ 子模型 "${name}" 正在运行中。已改为异步协作：布置工作后无需等待，直接结束本轮即可，子模型的提交会自动回到对话。`;
      }
      if (agent.status === 'done' && agent.submission) {
        try {
          const parsed = JSON.parse(agent.submission);
          return `📋 子模型 "${name}" 已完成\n\n概要: ${parsed.summary}\n详情: ${parsed.details}`;
        } catch { /* 非 JSON 提交走下方状态摘要 */ }
      }
      if (agent.status === 'error') {
        return `❌ 子模型 "${name}" 出错: ${agent.error || '未知错误'}`;
      }
      return `📋 子模型 "${name}" 当前状态: ${agent.status}`;
    }

    // 向子模型提问（轻量 LLM 调用）
    if (question) {
      try {
        const mainMsgs = messages as ModelMessage[];
        const mainSysPrompt = getSystemPrompt();
        const answer = await queryChildAgent(agent, mainMsgs, mainSysPrompt, question);
        return `💬 ${name} 的回答:\n${answer}`;
      } catch (err: any) {
        return `❌ 向子模型 "${name}" 提问时出错: ${err.message}`;
      }
    }

    // 纯状态查询
    const lines: string[] = [];
    lines.push(`📋 子模型: "${name}"`);
    lines.push(`模式: ${agent.mode}`);
    lines.push(`状态: ${agent.status}`);
    lines.push(`可用工具: ${(agent.tools ?? []).join(', ')}`);
    if (agent.submission) {
      try {
        const p = JSON.parse(agent.submission);
        lines.push(`\n最近提交概要: ${p.summary || '(无)'}`);
      } catch {
        lines.push(`\n最近提交: ${agent.submission}`);
      }
    }
    if (agent.error) lines.push(`\n错误: ${agent.error}`);
    return lines.join('\n');
  },
});

// ═════════════════════════════════════════════════════
// agent_worklog — 查看子模型工作记录（谁做过什么）
// ═════════════════════════════════════════════════════

tools['agent_worklog'] = tool({
  description: '查看子模型的工作记录（Worklog）。子模型长对话会被自动压缩为结构化工作记录并落盘（subagent-worklog 文件夹）。不传 name 时列出所有有工作记录的子模型（用于判断“谁了解什么”，优先把任务派给有经验的人）；传 name 列出该子模型的历史工作记录；传 name+id 查看某条记录的完整梗概。',
  inputSchema: z.object({
    name: z.string().optional().describe('（可选）子模型名称；不传则列出所有有工作记录的子模型'),
    id: z.string().optional().describe('（可选）工作记录 id（如 W1）；需配合 name 查看该条完整梗概'),
  }),
  execute: async ({ name, id }) => {
    subagentWorklogStore.setSessionId(subagentContextStore.getSessionId());
    if (!name) {
      const agents = subagentWorklogStore.listAgents();
      if (agents.length === 0) return '暂无子模型的工作记录（子模型长对话压缩后才会沉淀）。';
      return ['📚 已有工作记录的子模型（优先把任务派给这些“有了解的人”）：',
        ...agents.map((a) => `- ${a.agentName}（${a.count} 条记录${a.lastTitle ? `，最近：${a.lastTitle}` : ''}）`),
        '', '查看具体记录：agent_worklog{name: "子模型名"}'].join('\n');
    }
    subagentWorklogStore.setActiveAgent(name);
    if (id) {
      const e = subagentWorklogStore.get(id);
      return e ? `[${e.id}] ${e.title}（${e.createdAt}）\n${e.summary}` : `未找到 ${name} 的 ${id} 记录。`;
    }
    const list = subagentWorklogStore.list();
    if (list.length === 0) return `子模型 "${name}" 暂无工作记录（可能尚未经历过上下文压缩，可用 agent_query 查询其状态）。`;
    return [`📚 子模型 "${name}" 的工作记录：`,
      ...list.map((e) => `- [${e.id}] ${e.title}（${e.createdAt}）`),
      '', `查看完整梗概：agent_worklog{name: "${name}", id: "W1"}`].join('\n');
  },
});

// ═════════════════════════════════════════════════════
// agent_fire — 销毁子模型
// ═════════════════════════════════════════════════════

tools['agent_fire'] = tool({
  description: '解雇/销毁指定名称的子模型。子模型会被立即销毁，其所有状态将丢失。',
  inputSchema: z.object({
    name: z.string().describe('要销毁的子模型名称'),
  }),
  execute: async ({ name }) => {
    const existed = subAgentManager.fire(name);
    // 通知外部（electron-entry 推送 sidebar:data）：通讯录立即移除已销毁的子模型
    notifyTaskDispatched();
    if (existed) {
      return `🔥 已销毁子模型 "${name}"。`;
    }
    return `❓ 未找到子模型 "${name}"。`;
  },
});

// ═════════════════════════════════════════════════════
// a_submission — 提交工作结果（子模型内部使用）
// ═════════════════════════════════════════════════════
// 注意：a_submission 是子模型专用终端工具，由 runner.ts 的 buildChildTools
// 在组装子模型工具集时无条件注入（含幻觉模式执行器），主模型不需要它，
// 因此不在此全局注册——避免主模型的 payload / session 记录中出现该工具。
export default tools;

























